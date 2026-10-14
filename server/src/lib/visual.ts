import sharp, { type Sharp } from 'sharp';

/**
 * Local, deterministic image analysis. It measures colour, tone and layout structure only: it does
 * not recognise subjects, styles or text, and it is labelled that way wherever it is shown.
 */
export const VISUAL_MODEL = 'colour-tone-v1';
export const VISUAL_HASH_MODEL = 'dhash-64';

export interface VisualAnalysis {
  dhash: string;
  embedding: number[];
  width: number;
  height: number;
  /** Pixel means in 0..1, measured on the same 48×48 sample: Rec. 709 luminance and HSV saturation. */
  stats: { meanLuminance: number; meanSaturation: number };
}

// Decompression-bomb guard: refuse images with more than ~50 megapixels.
const PIXEL_LIMIT = 50_000_000;

function sqrtNormalize(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return counts.map((c) => Math.sqrt(c / total));
}

/** 64-bit difference hash: robust to resizing and recompression, used for near-identical images. */
async function dhash(img: Sharp): Promise<string> {
  const px = await img.clone().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let hex = '';
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) {
      byte = (byte << 1) | (px[row * 9 + col]! > px[row * 9 + col + 1]! ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Colour-and-tone vector: a 4×4×4 RGB histogram, an 8-bin luminance histogram and a 4-bin
 * saturation histogram, each square-root normalised (so cosine behaves like the Hellinger
 * affinity), weighted, and L2-normalised.
 */
async function colourTone(img: Sharp): Promise<{ vector: number[]; stats: VisualAnalysis['stats'] }> {
  const px = await img.clone().resize(48, 48, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  const rgb = new Array<number>(64).fill(0);
  const lum = new Array<number>(8).fill(0);
  const sat = new Array<number>(4).fill(0);
  let lumSum = 0;
  let satSum = 0;
  let n = 0;
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    rgb[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)]!++;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[Math.min(7, Math.floor(l / 32))]!++;
    lumSum += l / 255;
    n++;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const s = max === 0 ? 0 : (max - min) / max;
    sat[Math.min(3, Math.floor(s * 4))]!++;
    satSum += s;
  }
  const v = [...sqrtNormalize(rgb), ...sqrtNormalize(lum).map((x) => x * 0.8), ...sqrtNormalize(sat).map((x) => x * 0.6)];
  const norm = Math.hypot(...v) || 1;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    vector: v.map((x) => Number((x / norm).toFixed(5))),
    stats: { meanLuminance: round(lumSum / (n || 1)), meanSaturation: round(satSum / (n || 1)) },
  };
}

export async function analyzeImage(buf: Buffer): Promise<VisualAnalysis> {
  const img = sharp(buf, { limitInputPixels: PIXEL_LIMIT, failOn: 'error' }).rotate().flatten({ background: '#ffffff' });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('Not a readable image');
  const [hash, ct] = await Promise.all([dhash(img), colourTone(img)]);
  // EXIF orientations 5–8 swap the axes; report the dimensions as displayed.
  const swapped = (meta.orientation ?? 1) >= 5;
  return {
    dhash: hash, embedding: ct.vector, stats: ct.stats,
    width: swapped ? meta.height : meta.width, height: swapped ? meta.width : meta.height,
  };
}
