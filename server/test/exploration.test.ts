import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { createSession, runExploration } from '../src/modules/exploration/engine.js';
import { cooccurringTerms } from '../src/modules/exploration/expansion.js';
import { resetDb, FakeHttp, useFakeHttp } from './helpers.js';

// SYNTHETIC API-shaped responses; the term in the query decides which items come back.
function commonsFor(u: URL) {
  const q = u.searchParams.get('gsrsearch') ?? '';
  const slug = q.replace(/\W+/g, '-');
  return { query: { pages: [1, 2, 3].map((i) => ({ pageid: Number(`${slug.length}${i}${q.length}`), index: i, title: `File:${q} ${i}.jpg`,
    imageinfo: [{ thumburl: `https://upload.wikimedia.org/${slug}-${i}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${slug}-${i}.jpg`, mime: 'image/jpeg', extmetadata: { ImageDescription: { value: `${q} example ${i}` } } }] })) } };
}
const WD_SEARCH = { search: [{ id: 'Q1', label: 'Frutiger Aero', description: 'design aesthetic' }] };
const WD_CLAIMS = { entities: { Q1: { claims: { P135: [{ mainsnak: { datavalue: { value: { id: 'Q2' } } } }] } } } };
const WD_LABELS = { entities: { Q2: { labels: { en: { value: 'Skeuomorphism' } } } } };

beforeEach(resetDb);
afterEach(() => useFakeHttp(undefined));
afterAll(closeDb);

describe('exploration engine', () => {
  it('runs bounded multi-strategy exploration and stores provenance for every result', async () => {
    const fake = new FakeHttp([
      { match: (u) => u.hostname === 'commons.wikimedia.org', body: null },
      { match: (u) => u.hostname === 'www.wikidata.org' && u.searchParams.get('action') === 'wbsearchentities', body: WD_SEARCH },
      { match: (u) => u.hostname === 'www.wikidata.org' && u.searchParams.get('props') === 'claims', body: WD_CLAIMS },
      { match: (u) => u.hostname === 'www.wikidata.org', body: WD_LABELS },
    ]);
    // dynamic body for Commons
    const orig = fake.getText.bind(fake);
    fake.getText = async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'commons.wikimedia.org') {
        fake.calls.push(url);
        return { status: 200, url, contentType: 'application/json', body: JSON.stringify(commonsFor(u)) };
      }
      return orig(url);
    };
    useFakeHttp(fake);
    const id = await createSession(
      { query: 'frutiger aero', concepts: [], categories: [], mode: 'adjacent', sourceIds: ['wikimedia_commons'], novelty: 0.5, depth: 1, maxQueries: 5, maxResults: 12, useExternalAi: false },
      { actorId: null },
    );
    await runExploration(id);
    const s = (await db().query('SELECT * FROM exploration_sessions WHERE id = $1', [id])).rows[0];
    expect(s.status).toBe('completed');
    expect(s.new_count).toBeLessThanOrEqual(12);
    expect(s.new_count).toBeGreaterThan(3);
    const queries = (await db().query('SELECT query, origin, depth, rationale FROM exploration_queries WHERE session_id = $1 ORDER BY depth', [id])).rows;
    expect(queries.length).toBeLessThanOrEqual(5);
    expect(queries[0]).toMatchObject({ query: 'frutiger aero', origin: 'user', depth: 0 });
    const kg = queries.find((q) => q.origin === 'knowledge_graph');
    expect(kg?.rationale).toBe('Wikidata: Frutiger Aero → movement → Skeuomorphism');
    // documented relation stored with its property as provenance
    const rel = (await db().query('SELECT predicate, evidence, provenance FROM entity_relations')).rows[0];
    expect(rel).toMatchObject({ predicate: 'related_movement', evidence: 'documented', provenance: 'Wikidata P135 (movement)' });
    // each result traces back through its query chain
    const d = (await db().query(`SELECT path FROM reference_discoveries WHERE session_id = $1 AND query_text = 'Skeuomorphism' LIMIT 1`, [id])).rows[0];
    if (d) expect(d.path.map((p: { label: string }) => p.label)).toEqual(['frutiger aero', 'Skeuomorphism', 'wikimedia_commons']);
  });

  it('stops when paused and resumes without repeating finished queries', async () => {
    const fake = new FakeHttp([]);
    let n = 0;
    fake.getText = async (url: string) => {
      n++;
      if (n === 1) await db().query(`UPDATE exploration_sessions SET status = 'paused'`);
      return { status: 200, url, contentType: 'application/json', body: JSON.stringify(commonsFor(new URL(url))) };
    };
    useFakeHttp(fake);
    const id = await createSession(
      { query: 'web 2.0', concepts: ['aqua interface'], categories: [], mode: 'familiar', sourceIds: ['wikimedia_commons'], novelty: 0.5, depth: 0, maxQueries: 5, maxResults: 30, useExternalAi: false },
      { actorId: null },
    );
    await runExploration(id);
    expect((await db().query('SELECT status FROM exploration_sessions WHERE id = $1', [id])).rows[0].status).toBe('paused');
    const done1 = (await db().query(`SELECT count(*)::int AS n FROM exploration_queries WHERE session_id = $1 AND status = 'done'`, [id])).rows[0].n;
    expect(done1).toBe(1);
    await db().query(`UPDATE exploration_sessions SET status = 'queued' WHERE id = $1`, [id]);
    await runExploration(id);
    expect((await db().query('SELECT status FROM exploration_sessions WHERE id = $1', [id])).rows[0].status).toBe('completed');
    expect(n).toBe(2); // second query only
  });

  it('marks a session failed when every source fails, with the reasons', async () => {
    useFakeHttp(new FakeHttp([]));
    const id = await createSession(
      { query: 'x', concepts: [], categories: [], mode: 'familiar', sourceIds: ['internet_archive'], novelty: 0.5, depth: 0, maxQueries: 2, maxResults: 5, useExternalAi: false },
      { actorId: null },
    );
    await runExploration(id);
    const s = (await db().query('SELECT status, error_summary FROM exploration_sessions WHERE id = $1', [id])).rows[0];
    expect(s.status).toBe('failed');
    expect(s.error_summary).toMatch(/internet_archive/);
  });
});

describe('keyword expansion', () => {
  it('needs repeated co-occurrence evidence', () => {
    const texts = ['windows xp luna #frutigeraero', 'windows vista aero glass', 'windows 98 startup', 'random text'];
    const terms = cooccurringTerms('windows', texts).map((t) => t.term);
    expect(terms).not.toContain('luna'); // appears once only
    expect(cooccurringTerms('windows', ['windows aero', 'windows aero']).map((t) => t.term)).toEqual(['aero']);
  });
});
