import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { STATUS_LABEL, type FeedItem, type FeedResponse, type Status } from '../lib/types';
import { fmtNum } from '../lib/format';
import { Dialog, Empty, ErrorBox, Loading, PageHead, Seg, StatusBadge, Thumb, errorText, useToast } from '../components/ui';
import { RejectDialog, useStatusChange } from '../components/StatusActions';
import { isTyping } from '../App';

interface Facets {
  sources: { id: string; name: string; n: number }[];
  statuses: { status: Status; n: number }[];
  mediaTypes: { media_type: string; n: number }[];
  tags: { tag: string; n: number }[];
  creators: { creator_name: string; n: number }[];
}
interface SavedSearch { id: string; name: string; scope: string; params: Record<string, unknown> }

const DEFAULT_STATUSES: Status[] = ['discovered', 'saved', 'approved_consideration'];
const FILTER_KEYS = ['q', 'semantic', 'status', 'source', 'mediaType', 'creator', 'tag', 'periodFrom', 'periodTo', 'sessionId', 'duplicates', 'minScore', 'sort', 'mode', 'novelty'] as const;
const PAGE = 40;
type View = 'dense' | 'research';
const VIEW_KEY = 'radar.feedView';

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'research' ? 'research' : 'dense'; } catch { return 'dense'; }
}

export function useFeedParams() {
  const [sp, setSp] = useSearchParams();
  const params = useMemo(() => {
    const o: Record<string, string> = {};
    for (const k of FILTER_KEYS) {
      const v = sp.get(k);
      if (v !== null && v !== '') o[k] = v;
    }
    return o;
  }, [sp]);
  const set = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );
  return { params, set, replaceAll: (p: Record<string, string>) => setSp(new URLSearchParams(p), { replace: true }) };
}

export function RadarPage() {
  const { params, set, replaceAll } = useFeedParams();
  const nav = useNavigate();
  const statuses = (params.status?.split(',') as Status[] | undefined) ?? DEFAULT_STATUSES;
  const sort = params.sort ?? 'ranked';
  const mode = params.mode ?? 'adjacent';

  const feed = useInfiniteQuery({
    queryKey: ['feed', params],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<FeedResponse>(`/api/references${qs({ ...params, status: statuses, offset: pageParam, limit: PAGE })}`),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
  const facets = useQuery({ queryKey: ['facets'], queryFn: () => api.get<Facets>('/api/references-facets') });
  const items = useMemo(() => feed.data?.pages.flatMap((p) => p.items) ?? [], [feed.data]);
  const first = feed.data?.pages[0];

  const [sel, setSel] = useState(0);
  const [rejecting, setRejecting] = useState<FeedItem | null>(null);
  const [help, setHelp] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setViewState] = useState<View>(readView);
  const setView = useCallback((v: View) => {
    setViewState(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ }
  }, []);
  const status = useStatusChange();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => setSel(0), [params]);
  useEffect(() => {
    document.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const act = useCallback(
    (item: FeedItem, to: Status) => {
      if (to === 'rejected') return setRejecting(item);
      status.mutate({ refLabel: item.refLabel, change: { status: to }, previous: item.status });
    },
    [status],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || rejecting) return;
      const item = items[sel];
      switch (e.key) {
        case 'j': setSel((s) => Math.min(items.length - 1, s + 1)); break;
        case 'k': setSel((s) => Math.max(0, s - 1)); break;
        case 'o': case 'Enter': if (item) nav(`/ref/${item.refNumber}`); break;
        case 's': if (item) act(item, 'saved'); break;
        case 'a': if (item) act(item, 'approved_consideration'); break;
        case 'x': if (item) act(item, 'rejected'); break;
        case 'h': if (item) act(item, 'archived'); break;
        case '/': e.preventDefault(); searchRef.current?.focus(); break;
        case 'v': setView(view === 'dense' ? 'research' : 'dense'); break;
        case '?': setHelp(true); break;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, sel, act, nav, rejecting, view, setView]);

  // Load more when the sentinel scrolls into view
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting) && feed.hasNextPage && !feed.isFetchingNextPage) feed.fetchNextPage();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [feed]);

  const toggleIn = (key: 'status' | 'source' | 'mediaType', value: string, current: string[]) => {
    const next = current.includes(value) ? current.filter((x) => x !== value) : [...current, value];
    set({ [key]: next.length ? next.join(',') : key === 'status' ? '' : undefined });
  };

  return (
    <>
      <PageHead
        title="RADAR"
        sub={first ? `${fmtNum(first.total)} references${first.rankingVersion ? ` · ranking v${first.rankingVersion}` : ''}${first.semanticModel ? ` · semantic: ${first.semanticModel}` : ''}` : undefined}
      >
        <Seg label="Sort" value={sort} onChange={(v) => set({ sort: v === 'ranked' ? undefined : v })} options={[
          { value: 'ranked', label: 'Ranked' }, { value: 'recent', label: 'Recent' }, { value: 'ref_number', label: 'ID' },
        ]} />
        <Seg label="View" value={view} onChange={setView} options={[
          { value: 'dense', label: 'Dense' }, { value: 'research', label: 'Research' },
        ]} />
        <button className="ghost sm" onClick={() => setHelp(true)} title="Keyboard shortcuts"><kbd>?</kbd></button>
      </PageHead>
      <div className="content">
        <div className="feed-layout">
          <button className="filters-toggle sm" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>{filtersOpen ? 'Hide filters' : 'Filters'}</button>
          <aside className={`filters ${filtersOpen ? 'open' : ''}`} aria-label="Filters">
            <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); set({ q: String(f.get('q') ?? '') || undefined, semantic: String(f.get('semantic') ?? '') || undefined }); }} className="stack">
              <label className="field"><span>Search text or #ID</span>
                <input ref={searchRef} name="q" defaultValue={params.q ?? ''} key={`q${params.q ?? ''}`} placeholder="title, creator, tag…" />
              </label>
              <label className="field"><span>Concept (semantic)</span>
                <input name="semantic" defaultValue={params.semantic ?? ''} key={`s${params.semantic ?? ''}`} placeholder="e.g. early web zines" />
              </label>
              <button type="submit" className="sm">Apply search</button>
              <p className="small muted" style={{ margin: 0 }}>Semantic search uses a local lexical model (lexical-hash-v1), not a neural one. It matches related wording, not image content.</p>
            </form>

            {sort === 'ranked' || params.semantic ? (
              <fieldset>
                <legend>Discovery mode</legend>
                <Seg label="Mode" value={mode as 'familiar' | 'adjacent' | 'experimental'} onChange={(v) => set({ mode: v === 'adjacent' ? undefined : v })} options={[
                  { value: 'familiar', label: 'Familiar' }, { value: 'adjacent', label: 'Adjacent' }, { value: 'experimental', label: 'Exp.' },
                ]} />
                <label className="field" style={{ marginTop: 6 }}><span>Novelty {Number(params.novelty ?? 0.5).toFixed(2)}</span>
                  <input type="range" min={0} max={1} step={0.05} value={params.novelty ?? 0.5} onChange={(e) => set({ novelty: e.target.value === '0.5' ? undefined : e.target.value })} />
                </label>
                <label className="field"><span>Minimum score</span>
                  <select value={params.minScore ?? ''} onChange={(e) => set({ minScore: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {['0.3', '0.4', '0.5', '0.6', '0.7'].map((v) => <option key={v} value={v}>≥ {v}</option>)}
                  </select>
                </label>
              </fieldset>
            ) : null}

            <fieldset>
              <legend>Status</legend>
              {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
                <label key={s} className="check">
                  <input type="checkbox" checked={statuses.includes(s)} onChange={() => toggleIn('status', s, statuses)} />
                  {STATUS_LABEL[s]}
                  <span className="count">{facets.data?.statuses.find((x) => x.status === s)?.n ?? 0}</span>
                </label>
              ))}
            </fieldset>

            <fieldset>
              <legend>Source</legend>
              {facets.data?.sources.filter((s) => s.n > 0).map((s) => (
                <label key={s.id} className="check">
                  <input type="checkbox" checked={params.source?.split(',').includes(s.id) ?? false} onChange={() => toggleIn('source', s.id, params.source?.split(',') ?? [])} />
                  {s.name}<span className="count">{s.n}</span>
                </label>
              ))}
              {facets.data && !facets.data.sources.some((s) => s.n > 0) ? <span className="small muted">No references yet.</span> : null}
            </fieldset>

            <fieldset>
              <legend>Media</legend>
              {facets.data?.mediaTypes.map((m) => (
                <label key={m.media_type} className="check">
                  <input type="checkbox" checked={params.mediaType?.split(',').includes(m.media_type) ?? false} onChange={() => toggleIn('mediaType', m.media_type, params.mediaType?.split(',') ?? [])} />
                  {m.media_type}<span className="count">{m.n}</span>
                </label>
              ))}
            </fieldset>

            <fieldset>
              <legend>Period (year)</legend>
              <div className="row tight">
                <input aria-label="From year" style={{ width: 70 }} inputMode="numeric" placeholder="from" defaultValue={params.periodFrom ?? ''} onBlur={(e) => set({ periodFrom: /^\d{4}$/.test(e.target.value) ? e.target.value : undefined })} />
                <span>–</span>
                <input aria-label="To year" style={{ width: 70 }} inputMode="numeric" placeholder="to" defaultValue={params.periodTo ?? ''} onBlur={(e) => set({ periodTo: /^\d{4}$/.test(e.target.value) ? e.target.value : undefined })} />
              </div>
            </fieldset>

            <fieldset>
              <legend>Creator · tag</legend>
              <select aria-label="Creator" value={params.creator ?? ''} onChange={(e) => set({ creator: e.target.value || undefined })}>
                <option value="">Any creator</option>
                {facets.data?.creators.map((c) => <option key={c.creator_name} value={c.creator_name}>{c.creator_name} ({c.n})</option>)}
              </select>
              <select aria-label="Tag" value={params.tag ?? ''} onChange={(e) => set({ tag: e.target.value || undefined })}>
                <option value="">Any tag</option>
                {facets.data?.tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}
              </select>
            </fieldset>

            <fieldset>
              <legend>Duplicates</legend>
              <select aria-label="Duplicates" value={params.duplicates ?? 'any'} onChange={(e) => set({ duplicates: e.target.value === 'any' ? undefined : e.target.value })}>
                <option value="any">Show all</option>
                <option value="hide">Hide likely duplicates</option>
                <option value="only">Only likely duplicates</option>
              </select>
            </fieldset>

            {params.sessionId ? (
              <div className="notice small row between">From one exploration session <button className="sm" onClick={() => set({ sessionId: undefined })}>Clear</button></div>
            ) : null}

            <SavedSearches params={params} onApply={replaceAll} />
            <button className="sm" onClick={() => replaceAll({})}>Reset all filters</button>
          </aside>

          <section aria-label="References">
            <ErrorBox error={feed.error} retry={() => feed.refetch()} />
            {feed.isLoading ? <Loading label="Ranking references" /> : null}
            {!feed.isLoading && !feed.error && items.length === 0 ? (
              <Empty title="Nothing here yet">
                {Object.keys(params).length ? (
                  <p>No references match these filters. <button className="sm" onClick={() => replaceAll({})}>Reset filters</button></p>
                ) : (
                  <p>Run a search in <Link to="/explore">Explore</Link>, or add a single page from <Link to="/sources">Sources → Import from URL</Link>.</p>
                )}
              </Empty>
            ) : null}
            {view === 'dense' ? (
              <Masonry>
                {items.map((it, i) => (
                  <FeedCard key={it.id} item={it} idx={i} selected={i === sel} onSelect={() => setSel(i)} onAct={act} />
                ))}
              </Masonry>
            ) : (
              <div className="research-list">
                {items.map((it, i) => (
                  <FeedCard key={it.id} item={it} idx={i} selected={i === sel} onSelect={() => setSel(i)} onAct={act} detailed />
                ))}
              </div>
            )}
            <div ref={sentinel} />
            {feed.hasNextPage ? (
              <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
                <button onClick={() => feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>{feed.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>
              </div>
            ) : items.length > 0 ? <p className="small muted" style={{ textAlign: 'center' }}>End of results.</p> : null}
          </section>
        </div>
      </div>

      {rejecting ? (
        <RejectDialog
          refLabel={rejecting.refLabel}
          onCancel={() => setRejecting(null)}
          onConfirm={(c) => {
            status.mutate({ refLabel: rejecting.refLabel, change: c, previous: rejecting.status });
            setRejecting(null);
          }}
        />
      ) : null}
      {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
    </>
  );
}

/** Masonry that keeps rank order left-to-right: item i goes to column i % n. */
function Masonry({ children }: { children: ReactNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setCols(Math.max(1, Math.floor(((e?.contentRect.width ?? 900) + 12) / 242))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns: ReactNode[][] = Array.from({ length: cols }, () => []);
  children.forEach((c, i) => columns[i % cols]!.push(c));
  return (
    <div className="masonry" ref={ref} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {columns.map((c, i) => <div key={i}>{c}</div>)}
    </div>
  );
}

const ATTRIBUTION_LABEL: Record<string, string> = {
  source_provided: 'Creator as stated by the source', editor_confirmed: 'Creator confirmed by editor',
  reported_incorrect: 'Attribution reported incorrect', unknown: 'Creator not stated by the source',
};

function FeedCard({ item, idx, selected, onSelect, onAct, detailed = false }: { item: FeedItem; idx: number; selected: boolean; onSelect: () => void; onAct: (i: FeedItem, s: Status) => void; detailed?: boolean }) {
  const ratio = item.width && item.height ? `${item.width} / ${item.height}` : undefined;
  return (
    <article className={`card ${selected ? 'selected' : ''}`} data-idx={idx} onMouseDown={onSelect} aria-label={`${item.refLabel} ${item.title ?? ''}`}>
      <Link to={`/ref/${item.refNumber}`} className="media" style={ratio ? { aspectRatio: ratio } : undefined} tabIndex={-1}>
        <Thumb src={item.thumbnailUrl ?? item.previewUrl} alt={item.title ?? item.refLabel} />
        <div className="overlay">
          {item.duplicateCandidates > 0 ? <span className="badge warn" title="Likely duplicate of another reference">DUP?</span> : null}
          {item.mediaType !== 'image' ? <span className="badge">{item.mediaType}</span> : null}
        </div>
      </Link>
      {item.score !== null ? <div className="scorebar" title={`Score ${item.score.toFixed(2)}`}><i style={{ width: `${Math.round(item.score * 100)}%` }} /></div> : null}
      <div className="meta">
        <div className="top">
          <Link to={`/ref/${item.refNumber}`} className="refid">{item.refLabel}</Link>
          <StatusBadge status={item.status} />
        </div>
        <div className="title">{item.title ?? <span className="muted">Untitled</span>}</div>
        <div className="by">
          {item.creatorName ?? <span className="muted">Creator unknown</span>}
          {item.publishedRaw ? ` · ${item.publishedRaw}` : ''}
        </div>
        <div className="by small muted">{item.sourceName}{detailed ? ` · found ${new Date(item.discoveredAt).toLocaleDateString('en-GB')}` : ''}</div>
        {detailed ? (
          <>
            <div className="by small muted">{ATTRIBUTION_LABEL[item.attributionStatus] ?? item.attributionStatus}{item.score !== null ? ` · score ${item.score.toFixed(2)}` : ''}</div>
            {item.tags.length ? <div className="tags">{item.tags.slice(0, 8).map((t) => <span key={t} className="tagchip" style={{ paddingRight: 6, margin: 0 }}>{t}</span>)}</div> : null}
            {item.reasons.map((r) => <div key={r} className="why">↳ {r}</div>)}
            {item.caveats.map((c) => <div key={c} className="why">! {c}</div>)}
            {item.redundancy.map((r) => <div key={r.label} className="why">− {r.label}</div>)}
          </>
        ) : (
          <>
            {item.reasons.length ? <div className="why">↳ {item.reasons[0]}</div> : null}
            {item.caveats.length ? <div className="why">! {item.caveats.slice(0, 2).join(' · ')}</div> : null}
          </>
        )}
      </div>
      <div className="actions">
        <button onClick={() => onAct(item, 'saved')} disabled={item.status === 'saved'} title="Save for research (s)">Save</button>
        <button onClick={() => onAct(item, 'approved_consideration')} disabled={item.status === 'approved_consideration'} title="Approve for editorial consideration (a)">Approve</button>
        <button onClick={() => onAct(item, 'rejected')} disabled={item.status === 'rejected'} title="Reject with a reason (x)">Reject</button>
        <a className="btn" href={item.originalUrl} target="_blank" rel="noopener noreferrer" title="Open the original page" style={{ flex: 1, border: 0, borderRadius: 0, justifyContent: 'center', padding: '6px 2px', fontSize: 11, fontFamily: 'var(--mono)' }}>Source ↗</a>
      </div>
    </article>
  );
}

function SavedSearches({ params, onApply }: { params: Record<string, string>; onApply: (p: Record<string, string>) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['saved-searches'], queryFn: () => api.get<SavedSearch[]>('/api/saved-searches') });
  const save = useMutation({
    mutationFn: (name: string) => {
      const p: Record<string, unknown> = { ...params };
      return api.post('/api/saved-searches', { name, scope: 'feed', params: p });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-searches'] }),
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/saved-searches/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-searches'] }),
  });
  const feedSearches = list.data?.filter((s) => s.scope === 'feed') ?? [];
  return (
    <fieldset>
      <legend>Saved searches</legend>
      {feedSearches.map((s) => (
        <div key={s.id} className="row tight between">
          <button className="ghost sm" onClick={() => onApply(Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])))}>{s.name}</button>
          <button className="ghost sm" aria-label={`Delete saved search ${s.name}`} onClick={() => del.mutate(s.id)}>✕</button>
        </div>
      ))}
      <button
        className="sm"
        disabled={Object.keys(params).length === 0}
        title={Object.keys(params).length === 0 ? 'Set a filter or search first' : 'Save the current filters'}
        onClick={() => {
          const name = window.prompt('Name for this search');
          if (name?.trim()) save.mutate(name.trim());
        }}
      >
        Save current filters
      </button>
    </fieldset>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['j / k', 'Next / previous reference'], ['o or Enter', 'Open detail'], ['s', 'Save for research'], ['a', 'Approve for editorial consideration'],
    ['x', 'Reject (asks for a reason)'], ['h', 'Archive'], ['v', 'Switch dense / research view'], ['/', 'Focus search'], ['g then r/e/a/c/i/s', 'Go to RADAR / Explore / Archive / Studio / Insights / Sources'],
  ];
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <table className="data"><tbody>{rows.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
      <p className="small muted">Every status change shows an Undo for a few seconds and is recorded in the reference’s history.</p>
    </Dialog>
  );
}
