import type { HttpClient } from '../../../lib/http-client.js';
import type { SourceAdapter } from '../adapter.js';

/**
 * Wikidata is used as a knowledge graph for exploration (entities and documented relations), not
 * as an image source. Every relation returned carries the Wikidata property it came from.
 */
export const wikidataSource: SourceAdapter = {
  id: 'wikidata',
  name: 'Wikidata (knowledge graph)',
  connectorType: 'knowledge',
  baseUrl: 'https://www.wikidata.org/w/api.php',
  termsUrl: 'https://www.wikidata.org/wiki/Wikidata:Licensing',
  attribution: 'Structured data is CC0.',
  baselineReliability: 0.8,
  ratePerMinute: 60,
  requiresCredentials: false,
  allowsMediaCaching: true,
  capabilities: { search: false, pagination: false, creator: false, previews: false, dates: true, licenses: true },
  accessNotes:
    'Public Wikibase API (no key). Used by Explore to find artists, movements, works, technologies and periods related to a query, and to follow documented relations (creator, movement, genre, influenced by, part of…). Relations are labelled "documented" with their Wikidata property.',
  missingConfiguration: () => [],
};

export interface WdEntity {
  id: string;
  label: string;
  description?: string;
}

export interface WdRelation {
  property: string;
  propertyLabel: string;
  predicate: 'created_by' | 'related_movement' | 'genre' | 'influenced_by' | 'part_of' | 'instance_of' | 'associated_with' | 'uses_technique' | 'belongs_to_period';
  target: WdEntity;
}

// Properties worth following for cultural exploration, with the relation they document.
export const FOLLOW_PROPERTIES: Record<string, { label: string; predicate: WdRelation['predicate'] }> = {
  P170: { label: 'creator', predicate: 'created_by' },
  P50: { label: 'author', predicate: 'created_by' },
  P178: { label: 'developer', predicate: 'created_by' },
  P287: { label: 'designed by', predicate: 'created_by' },
  P86: { label: 'composer', predicate: 'created_by' },
  P135: { label: 'movement', predicate: 'related_movement' },
  P136: { label: 'genre', predicate: 'genre' },
  P737: { label: 'influenced by', predicate: 'influenced_by' },
  P361: { label: 'part of', predicate: 'part_of' },
  P31: { label: 'instance of', predicate: 'instance_of' },
  P279: { label: 'subclass of', predicate: 'instance_of' },
  P2079: { label: 'fabrication method', predicate: 'uses_technique' },
  P921: { label: 'main subject', predicate: 'associated_with' },
  P800: { label: 'notable work', predicate: 'associated_with' },
  P2184: { label: 'history of topic', predicate: 'associated_with' },
  P1269: { label: 'facet of', predicate: 'associated_with' },
  P2348: { label: 'time period', predicate: 'belongs_to_period' },
};

// Very generic classes that make poor exploration branches
const GENERIC = new Set(['Q5', 'Q35120', 'Q488383', 'Q151885', 'Q7184903', 'Q17537576', 'Q838948', 'Q4167836', 'Q13442814', 'Q1190554', 'Q16521', 'Q215627']);

interface SearchResp { search?: { id: string; label?: string; description?: string }[] }
interface EntitiesResp { entities?: Record<string, { labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }>; claims?: Record<string, { mainsnak?: { datavalue?: { value?: { id?: string } } } }[]> }> }

export class WikidataClient {
  constructor(private readonly http: HttpClient) {}

  private opts = { rateKey: 'wikidata', ratePerMinute: 60 };

  async searchEntities(query: string, limit = 5): Promise<WdEntity[]> {
    const url = new URL('https://www.wikidata.org/w/api.php');
    Object.entries({ action: 'wbsearchentities', search: query, language: 'en', uselang: 'en', type: 'item', limit: String(limit), format: 'json' })
      .forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await this.http.getJson<SearchResp>(url.toString(), this.opts);
    return (r.search ?? []).filter((s) => /^Q\d+$/.test(s.id)).map((s) => ({ id: s.id, label: s.label ?? s.id, description: s.description }));
  }

  /** Documented outgoing relations of an entity, restricted to FOLLOW_PROPERTIES. */
  async relations(qid: string, maxTargets = 12): Promise<WdRelation[]> {
    if (!/^Q\d+$/.test(qid)) return [];
    const url = new URL('https://www.wikidata.org/w/api.php');
    Object.entries({ action: 'wbgetentities', ids: qid, props: 'claims', format: 'json' }).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await this.http.getJson<EntitiesResp>(url.toString(), this.opts);
    const claims = r.entities?.[qid]?.claims ?? {};
    const pairs: { property: string; id: string }[] = [];
    for (const [prop, list] of Object.entries(claims)) {
      if (!FOLLOW_PROPERTIES[prop]) continue;
      for (const c of list) {
        const id = c.mainsnak?.datavalue?.value?.id;
        if (id && /^Q\d+$/.test(id) && !GENERIC.has(id)) pairs.push({ property: prop, id });
      }
    }
    const targets = [...new Set(pairs.map((p) => p.id))].slice(0, maxTargets);
    if (!targets.length) return [];
    const labels = await this.labels(targets);
    return pairs
      .filter((p) => labels.has(p.id))
      .map((p) => ({
        property: p.property,
        propertyLabel: FOLLOW_PROPERTIES[p.property]!.label,
        predicate: FOLLOW_PROPERTIES[p.property]!.predicate,
        target: labels.get(p.id)!,
      }));
  }

  async labels(ids: string[]): Promise<Map<string, WdEntity>> {
    const url = new URL('https://www.wikidata.org/w/api.php');
    Object.entries({ action: 'wbgetentities', ids: ids.slice(0, 50).join('|'), props: 'labels|descriptions', languages: 'en', format: 'json' })
      .forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await this.http.getJson<EntitiesResp>(url.toString(), this.opts);
    const out = new Map<string, WdEntity>();
    for (const [id, e] of Object.entries(r.entities ?? {})) {
      const label = e.labels?.en?.value;
      if (label) out.set(id, { id, label, description: e.descriptions?.en?.value });
    }
    return out;
  }
}
