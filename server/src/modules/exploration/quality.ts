import { tokenize } from '../../lib/text.js';
import type { DiscoveredItem } from '../references/types.js';

/**
 * A gate between a source's search results and the RADAR feed. Sources answer full-text queries
 * loosely (a word in a long description is enough), so without this the feed fills with material
 * eccö cannot use: items with nothing to look at, video and audio, and administrative documents
 * that merely mention the topic. The gate judges each result only on the metadata the source
 * returned; it never edits that metadata. Every result it sets aside is counted on the run.
 */
export type SetAsideReason = 'no_preview' | 'not_visual' | 'administrative' | 'off_topic';

/** Media RADAR can show as a visual reference. Text covers scanned print (magazines, manuals). */
const VISUAL_MEDIA = new Set(['image', 'text', 'webpage']);

/**
 * Titles of government and institutional records: hearings, committee papers, reports. They
 * often mention a topic in passing ("Y2K") without being visual culture.
 */
const ADMINISTRATIVE = /\b(hearings?|committee|subcommittee|congress(ional)?|senate|house of representatives|serial no|testimony|legislation|bill to|annual report|budget|proceedings|minutes of|federal register|department of|agency|inquiry|statement of)\b/i;

/** Creators that are institutions rather than people or studios; following them leads to records. */
export const INSTITUTIONAL_CREATOR = /\b(committee|congress|senate|department|ministry|agency|government|office of|administration|council|commission|nasa|bureau|parliament|united states|u\.s\.)\b/i;

/** First five letters of a word, so "interface" and "interfaces" match. */
const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);

export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query).filter((t) => t.length >= 3 || /\d/.test(t)))];
}

/** How many of the query's words appear in the result's own title, description, tags or creator. */
export function termsMatched(item: Pick<DiscoveredItem, 'title' | 'description' | 'tags' | 'creatorName'>, query: string): number {
  const terms = queryTerms(query);
  const have = new Set(tokenize([item.title, item.description, (item.tags ?? []).join(' '), item.creatorName].filter(Boolean).join(' ')).map(stem));
  return terms.filter((t) => have.has(stem(t))).length;
}

export function assessResult(item: DiscoveredItem, query: string): { keep: true } | { keep: false; reason: SetAsideReason } {
  if (!item.previewUrl && !item.thumbnailUrl) return { keep: false, reason: 'no_preview' };
  if (!VISUAL_MEDIA.has(item.mediaType)) return { keep: false, reason: 'not_visual' };
  if (ADMINISTRATIVE.test(item.title ?? '')) return { keep: false, reason: 'administrative' };
  const terms = queryTerms(query);
  // A three-word query needs two of its words in the result, so one common word ("web") is not enough.
  const needed = terms.length >= 3 ? 2 : terms.length ? 1 : 0;
  if (termsMatched(item, query) < needed) return { keep: false, reason: 'off_topic' };
  return { keep: true };
}
