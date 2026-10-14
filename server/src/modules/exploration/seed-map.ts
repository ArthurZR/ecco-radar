/**
 * A hand-written map of eccö's editorial territory, used only to suggest *search terms* when the
 * Adjacent and Experimental modes branch out. It makes no factual claims about the material it
 * finds: every expansion is labelled as coming from this map, and results are judged on their own
 * source metadata. Editors can extend it in code; learned tags and history supplement it at runtime.
 */
export const SEED_MAP: Record<string, string[]> = {
  'frutiger aero': ['windows vista', 'aqua interface', 'glossy icons', 'skeuomorphic interface', 'web 2.0 design', 'nature screensaver', 'aquarium screensaver'],
  'frutiger metro': ['metro design language', 'windows phone', 'zune', 'flat interface typography', 'segoe'],
  y2k: ['millennium design', 'chrome typography', 'cyber fashion', 'early 2000s advertising', 'translucent plastic', 'blobject', 'iMac G3'],
  'early web': ['personal homepage', 'geocities', 'web banner', 'under construction gif', 'web graphics', 'webring', 'pixel font'],
  'personal website': ['geocities', 'homepage', 'webring', 'guestbook', 'blinkies', 'neocities'],
  'operating system': ['graphical user interface', 'desktop wallpaper', 'system icons', 'boot screen', 'software manual', 'mac os 9', 'windows 95'],
  interface: ['graphical user interface', 'software skin', 'media player skin', 'winamp skin', 'icon design', 'interaction design'],
  'video game': ['game advertisement', 'game manual', 'box art', 'sprite art', 'low poly', 'arcade cabinet', 'game magazine'],
  'game graphics': ['sprite art', 'low poly', 'pre-rendered background', 'demoscene', 'pixel art'],
  anime: ['cel animation', 'anime production art', 'anime magazine', 'mecha design', 'animation layout'],
  manga: ['manga magazine', 'tankobon cover', 'screentone', 'manga artist'],
  fashion: ['fashion archive', 'runway', 'fashion editorial', 'lookbook', 'experimental fashion', 'streetwear'],
  streetwear: ['skate graphics', 'street fashion photography', 'fashion zine', 'logo t-shirt'],
  'album artwork': ['album cover', 'record sleeve', 'cd booklet', 'music packaging', 'flyer design'],
  'hip-hop': ['hip-hop flyer', 'graffiti', 'mixtape cover', 'breakdance', 'hip-hop photography'],
  typography: ['type specimen', 'lettering', 'logo design', 'poster typography', 'bitmap font', 'swiss style'],
  'graphic design': ['poster design', 'swiss style', 'logo design', 'corporate identity', 'design manual', 'magazine layout'],
  cgi: ['3d rendering', 'computer graphics', 'raytracing', 'siggraph', 'demoscene', 'early cgi'],
  '3d graphics': ['3d rendering', 'low poly', 'wireframe', 'computer graphics', 'raytracing'],
  'digital art': ['net art', 'computer art', 'generative art', 'glitch art', 'pixel art'],
  film: ['production design', 'film still', 'movie poster', 'title sequence', 'storyboard'],
  photography: ['documentary photography', 'street photography', 'fashion photography', 'photo archive'],
  'obsolete technology': ['pda', 'pager', 'minidisc', 'crt monitor', 'floppy disk', 'computer magazine', 'tamagotchi'],
  'internet culture': ['online community', 'forum', 'meme history', 'net art', 'early web'],
  'computer magazine': ['computer advertisement', 'software box', 'magazine cover', 'tech catalog'],
  'net art': ['internet art', 'browser art', 'digital art', 'early web'],
};

/** Seed neighbours for a query: exact keys first, then keys sharing a word with the query. */
export function seedNeighbours(query: string): { key: string; terms: string[] }[] {
  const q = query.toLowerCase();
  const words = new Set(q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const out: { key: string; terms: string[] }[] = [];
  for (const [key, terms] of Object.entries(SEED_MAP)) {
    if (q.includes(key) || key.includes(q)) out.push({ key, terms });
  }
  if (!out.length) {
    for (const [key, terms] of Object.entries(SEED_MAP)) {
      if (key.split(' ').some((w) => words.has(w)) || terms.some((t) => t.split(' ').some((w) => w.length > 3 && words.has(w)))) out.push({ key, terms });
    }
  }
  return out.slice(0, 3);
}
