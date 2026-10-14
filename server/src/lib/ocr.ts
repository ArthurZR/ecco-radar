import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';

/**
 * Local text detection (OCR) with Tesseract. The engine and the English model ship with the npm
 * packages, so no image or text leaves the server. Output is a suggestion: OCR misreads stylised
 * type and invents letters in textures, so only confident words are kept and the editor reviews
 * the result before it is used as a fact.
 */
export const OCR_MODEL = 'tesseract-5 eng (best_int)';

const require = createRequire(import.meta.url);
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

/** Words below this confidence (0–100) are dropped. */
export const MIN_WORD_CONFIDENCE = 75;
const IDLE_MS = 120_000;

export interface OcrResult {
  /** Kept words, one detected line per line. Empty when nothing legible was found. */
  text: string;
  /** Mean confidence of the kept words (0–100), or null when none were kept. */
  confidence: number | null;
  words: number;
}

let worker: Promise<Worker> | null = null;
let idle: NodeJS.Timeout | null = null;
// One recognition at a time: Tesseract is CPU-bound and the app is single-editor.
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<Worker> {
  worker ??= createWorker('eng', 1, { langPath: LANG_PATH, cachePath: path.join(tmpdir(), 'radar-ocr-cache'), gzip: true, logger: () => {} });
  return worker;
}

function scheduleIdleShutdown(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => void stopOcr(), IDLE_MS);
  idle.unref();
}

export async function stopOcr(): Promise<void> {
  if (idle) clearTimeout(idle);
  idle = null;
  const w = worker;
  worker = null;
  if (w) await (await w).terminate();
}

/** Keeps confident words with at least two letters or digits; joins them line by line. */
export function keepConfidentText(lines: { words: { text: string; confidence: number }[] }[]): OcrResult {
  const kept: string[] = [];
  const confidences: number[] = [];
  for (const line of lines) {
    const words = line.words.filter((w) => w.confidence >= MIN_WORD_CONFIDENCE && /[\p{L}\p{N}]{2,}/u.test(w.text));
    if (!words.length) continue;
    kept.push(words.map((w) => w.text.trim()).join(' '));
    confidences.push(...words.map((w) => w.confidence));
  }
  return {
    text: kept.join('\n'),
    confidence: confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null,
    words: confidences.length,
  };
}

/** Upscales small images (OCR needs letters a few dozen pixels high) and caps very large ones. */
async function prepare(buf: Buffer): Promise<Buffer> {
  const img = sharp(buf, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate().flatten({ background: '#ffffff' });
  const meta = await img.metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (!longest) throw new Error('Not a readable image');
  const target = longest < 1000 ? 1600 : Math.min(longest, 2400);
  return img.resize(target, target, { fit: 'inside', withoutEnlargement: false }).greyscale().png().toBuffer();
}

export function detectText(buf: Buffer): Promise<OcrResult> {
  const run = queue.then(async () => {
    const input = await prepare(buf);
    const w = await getWorker();
    try {
      const { data } = await w.recognize(input, {}, { blocks: true, text: false });
      const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
      return keepConfidentText(lines);
    } finally {
      scheduleIdleShutdown();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
