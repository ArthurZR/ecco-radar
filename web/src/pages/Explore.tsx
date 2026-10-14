import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Empty, ErrorBox, Loading, PageHead, Seg, errorText, useToast } from '../components/ui';

type Mode = 'familiar' | 'adjacent' | 'experimental';
interface Options { sources: { id: string; name: string; ready: boolean; notReady: string | null }[]; modes: Record<Mode, string[]> }
interface SessionRow {
  id: string; query: string; mode: Mode; source_ids: string[]; status: string; trigger: string; results_count: number; new_count: number;
  error_summary: string | null; created_at: string; started_at: string | null; completed_at: string | null; depth: number; max_queries: number; max_results: number;
}
interface QueryRow { id: string; parent_query_id: string | null; query: string; depth: number; origin: string; rationale: string | null; status: string; results_count: number; error: string | null; executed_at: string | null }
interface Schedule { id: string; name: string; enabled: boolean; params: Params; interval_minutes: number; max_runs_per_day: number; next_run_at: string | null; last_run_at: string | null }
interface Settings { settings: Record<string, { value: boolean }>; ai: { configured: boolean } }

interface Params {
  query: string; concepts: string[]; categories: string[]; mode: Mode; sourceIds: string[]; creator?: string; periodFrom?: number; periodTo?: number;
  novelty: number; depth: number; maxQueries: number; maxResults: number; useExternalAi: boolean;
}

const MODE_TEXT: Record<Mode, string> = {
  familiar: 'Close to what eccö already publishes and approves.',
  adjacent: 'Related territory: neighbouring scenes, creators and documented connections.',
  experimental: 'Further away, with each step of the connection shown. Items with no traceable connection are penalised.',
};
const ORIGIN_TEXT: Record<string, string> = {
  concept: 'your concept', history: 'eccö post history', approved_tags: 'approved tags', seed_map: 'eccö territory map',
  knowledge_graph: 'Wikidata (documented)', creator: 'creator', ai_suggestion: 'AI suggestion', user: 'your query',
};
const ACTIVE = ['queued', 'running'];

export function ExplorePage() {
  const { id } = useParams();
  return (
    <>
      <PageHead title="Explore" sub="Bounded, explainable discovery runs" />
      <div className="content">
        {id ? <SessionDetail id={id} /> : null}
        <div className="grid2" style={{ marginTop: id ? 12 : 0 }}>
          <NewExploration />
          <div className="stack lg">
            <SessionList />
            <Schedules />
          </div>
        </div>
      </div>
    </>
  );
}

function NewExploration() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const options = useQuery({ queryKey: ['exploration-options'], queryFn: () => api.get<Options>('/api/exploration/options') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const aiReady = !!settings.data?.ai.configured && !!settings.data?.settings.external_ai_enabled?.value;
  const [p, setP] = useState<Params>({ query: '', concepts: [], categories: [], mode: 'adjacent', sourceIds: [], novelty: 0.5, depth: 1, maxQueries: 8, maxResults: 60, useExternalAi: false });
  const [conceptText, setConceptText] = useState('');
  const [schedule, setSchedule] = useState<{ name: string; interval: number; perDay: number } | null>(null);

  useEffect(() => {
    if (options.data && p.sourceIds.length === 0) setP((x) => ({ ...x, sourceIds: options.data.sources.filter((s) => s.ready).map((s) => s.id) }));
  }, [options.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = (): Params => ({ ...p, concepts: conceptText.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10), creator: p.creator || undefined });
  const run = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/explorations', body()),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['explorations'] }); nav(`/explore/${r.id}`); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const saveSchedule = useMutation({
    mutationFn: () => api.post('/api/schedules', { name: schedule!.name, enabled: false, params: body(), intervalMinutes: schedule!.interval, maxRunsPerDay: schedule!.perDay }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedules'] }); setSchedule(null); toast({ text: 'Schedule saved (off). Turn it on in the list when ready.' }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });

  const submit = (e: FormEvent) => { e.preventDefault(); run.mutate(); };
  const canRun = p.query.trim().length > 0 && p.sourceIds.length > 0;

  return (
    <form className="panel" onSubmit={submit}>
      <header><h2>New exploration</h2></header>
      <div className="body stack">
        <label className="field"><span>Starting point</span>
          <input value={p.query} onChange={(e) => setP({ ...p, query: e.target.value })} placeholder="e.g. Y2K web interfaces, Memphis Group, rave flyers" required maxLength={300} />
        </label>
        <label className="field"><span>Extra concepts (comma separated, optional)</span>
          <input value={conceptText} onChange={(e) => setConceptText(e.target.value)} placeholder="chrome type, pixel fonts" />
        </label>
        <div>
          <Seg label="Mode" value={p.mode} onChange={(mode) => setP({ ...p, mode })} options={[{ value: 'familiar', label: 'Familiar' }, { value: 'adjacent', label: 'Adjacent' }, { value: 'experimental', label: 'Experimental' }]} />
          <p className="small muted" style={{ marginTop: 4 }}>{MODE_TEXT[p.mode]} Expansion uses: {options.data?.modes[p.mode].map((o) => ORIGIN_TEXT[o] ?? o).join(', ')}.</p>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted">Sources</legend>
          {options.isLoading ? <Loading /> : null}
          <ErrorBox error={options.error} />
          <div className="row">
            {options.data?.sources.map((s) => (
              <label key={s.id} className="check" title={s.notReady ?? ''} style={s.ready ? undefined : { color: 'var(--ink-3)' }}>
                <input type="checkbox" disabled={!s.ready} checked={s.ready && p.sourceIds.includes(s.id)} onChange={() => setP({ ...p, sourceIds: p.sourceIds.includes(s.id) ? p.sourceIds.filter((x) => x !== s.id) : [...p.sourceIds, s.id] })} />
                {s.name}{s.notReady ? <span className="small"> ({s.notReady})</span> : null}
              </label>
            ))}
          </div>
          <p className="small muted">Sources that need a key or are switched off cannot be selected. See <Link to="/sources">Sources</Link> for status and credentials.</p>
        </fieldset>
        <div className="row">
          <label className="field"><span>Creator</span><input value={p.creator ?? ''} onChange={(e) => setP({ ...p, creator: e.target.value })} style={{ width: 160 }} /></label>
          <label className="field"><span>From year</span><input inputMode="numeric" style={{ width: 80 }} value={p.periodFrom ?? ''} onChange={(e) => setP({ ...p, periodFrom: /^\d{4}$/.test(e.target.value) ? Number(e.target.value) : undefined })} /></label>
          <label className="field"><span>To year</span><input inputMode="numeric" style={{ width: 80 }} value={p.periodTo ?? ''} onChange={(e) => setP({ ...p, periodTo: /^\d{4}$/.test(e.target.value) ? Number(e.target.value) : undefined })} /></label>
        </div>
        <div className="row">
          <label className="field"><span>Novelty {p.novelty.toFixed(2)}</span><input type="range" min={0} max={1} step={0.05} value={p.novelty} onChange={(e) => setP({ ...p, novelty: Number(e.target.value) })} /></label>
          <label className="field"><span>Depth</span>
            <select value={p.depth} onChange={(e) => setP({ ...p, depth: Number(e.target.value) })}>{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}{n === 0 ? ' (query only)' : ''}</option>)}</select>
          </label>
          <label className="field"><span>Max queries</span><input type="number" min={1} max={40} value={p.maxQueries} onChange={(e) => setP({ ...p, maxQueries: Math.max(1, Math.min(40, Number(e.target.value))) })} style={{ width: 70 }} /></label>
          <label className="field"><span>Max results</span><input type="number" min={1} max={500} value={p.maxResults} onChange={(e) => setP({ ...p, maxResults: Math.max(1, Math.min(500, Number(e.target.value))) })} style={{ width: 80 }} /></label>
        </div>
        <label className="check" title={aiReady ? '' : 'Configure an AI provider and enable it in Settings first'}>
          <input type="checkbox" disabled={!aiReady} checked={p.useExternalAi && aiReady} onChange={(e) => setP({ ...p, useExternalAi: e.target.checked })} />
          Let the AI provider suggest extra queries (experimental mode only; sends the query text, nothing else)
        </label>
        {!aiReady ? <p className="small muted" style={{ marginTop: -4 }}>AI suggestions are off: {settings.data?.ai.configured ? 'enable external AI in Settings.' : 'no AI provider key is configured on the server.'}</p> : null}
        <div className="row">
          <button className="primary" type="submit" disabled={!canRun || run.isPending}>{run.isPending ? 'Starting…' : 'Run exploration'}</button>
          <button type="button" disabled={!canRun} onClick={() => setSchedule({ name: p.query, interval: 24 * 60, perDay: 1 })}>Save as schedule…</button>
        </div>
        {schedule ? (
          <div className="notice stack">
            <b>Background schedule</b>
            <p className="small">Schedules are created switched off. When on, they run in the background within these limits and respect the global pause in Settings.</p>
            <div className="row">
              <label className="field"><span>Name</span><input value={schedule.name} onChange={(e) => setSchedule({ ...schedule, name: e.target.value })} /></label>
              <label className="field"><span>Every</span>
                <select value={schedule.interval} onChange={(e) => setSchedule({ ...schedule, interval: Number(e.target.value) })}>
                  <option value={60}>hour</option><option value={360}>6 hours</option><option value={720}>12 hours</option><option value={1440}>day</option><option value={10080}>week</option>
                </select>
              </label>
              <label className="field"><span>Max runs/day</span><input type="number" min={1} max={24} value={schedule.perDay} onChange={(e) => setSchedule({ ...schedule, perDay: Number(e.target.value) })} style={{ width: 70 }} /></label>
            </div>
            <div className="row"><button type="button" className="primary sm" disabled={!schedule.name.trim() || saveSchedule.isPending} onClick={() => saveSchedule.mutate()}>Save schedule</button><button type="button" className="sm" onClick={() => setSchedule(null)}>Cancel</button></div>
          </div>
        ) : null}
      </div>
    </form>
  );
}

function SessionList() {
  const list = useQuery({
    queryKey: ['explorations'],
    queryFn: () => api.get<SessionRow[]>('/api/explorations?limit=30'),
    refetchInterval: (q) => (q.state.data?.some((s) => ACTIVE.includes(s.status)) ? 3000 : false),
  });
  return (
    <section className="panel">
      <header><h2>Sessions</h2></header>
      <div className="body">
        {list.isLoading ? <Loading /> : null}
        <ErrorBox error={list.error} retry={() => list.refetch()} />
        {list.data?.length === 0 ? <Empty title="No explorations yet">Start one on the left.</Empty> : null}
        {list.data?.length ? (
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>Query</th><th>Mode</th><th>Status</th><th className="num">New / total</th><th>Started</th></tr></thead>
              <tbody>
                {list.data.map((s) => (
                  <tr key={s.id}>
                    <td><Link to={`/explore/${s.id}`}>{s.query}</Link>{s.trigger !== 'manual' ? <span className="small muted"> · {s.trigger.replace('_', ' ')}</span> : null}</td>
                    <td className="small">{s.mode}</td>
                    <td><SessionStatus s={s.status} /></td>
                    <td className="num">{s.new_count} / {s.results_count}</td>
                    <td className="small nowrap">{fmtDateTime(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SessionStatus({ s }: { s: string }) {
  const tone = s === 'completed' ? 'green' : s === 'failed' ? 'danger' : s === 'running' || s === 'queued' ? 'solid' : s === 'paused' ? 'warn' : '';
  return <span className={`badge ${tone}`}>{s}</span>;
}

function SessionDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({
    queryKey: ['exploration', id],
    queryFn: () => api.get<{ session: SessionRow & Record<string, unknown>; queries: QueryRow[] }>(`/api/explorations/${id}`),
    refetchInterval: (x) => (x.state.data && ACTIVE.includes(x.state.data.session.status) ? 2000 : false),
  });
  const act = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'cancel' | 'repeat') => api.post<{ ok?: boolean; id?: string }>(`/api/explorations/${id}/${a}`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['exploration', id] });
      qc.invalidateQueries({ queryKey: ['explorations'] });
      if (r.id) nav(`/explore/${r.id}`);
    },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  useEffect(() => {
    if (q.data?.session.status === 'completed') qc.invalidateQueries({ queryKey: ['feed'] });
  }, [q.data?.session.status, qc]);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const s = q.data.session;
  const children = (pid: string | null) => q.data!.queries.filter((x) => x.parent_query_id === pid);
  const Node = ({ n }: { n: QueryRow }) => (
    <li>
      <span className="mono">{n.query}</span>{' '}
      <span className="small muted">via {ORIGIN_TEXT[n.origin] ?? n.origin}{n.rationale ? `: ${n.rationale}` : ''}</span>{' '}
      <span className={`badge ${n.status === 'done' ? '' : n.status === 'failed' ? 'danger' : 'warn'}`}>{n.status}{n.status === 'done' ? ` · ${n.results_count}` : ''}</span>
      {n.error ? <div className="small" style={{ color: 'var(--danger)' }}>{n.error}</div> : null}
      {children(n.id).length ? <ul>{children(n.id).map((c) => <Node key={c.id} n={c} />)}</ul> : null}
    </li>
  );
  return (
    <section className="panel">
      <header>
        <h2>“{s.query}” <span className="small muted">· {s.mode}</span></h2>
        <div className="row tight">
          <SessionStatus s={s.status} />
          {ACTIVE.includes(s.status) ? <button className="sm" onClick={() => act.mutate('pause')}>Pause</button> : null}
          {s.status === 'paused' ? <button className="sm" onClick={() => act.mutate('resume')}>Resume</button> : null}
          {[...ACTIVE, 'paused'].includes(s.status) ? <button className="sm danger" onClick={() => act.mutate('cancel')}>Cancel</button> : null}
          {['completed', 'failed', 'cancelled'].includes(s.status) ? <button className="sm" onClick={() => act.mutate('repeat')}>Repeat</button> : null}
        </div>
      </header>
      <div className="body stack">
        <div className="row small">
          <span>{s.results_count} results · <b>{s.new_count} new</b></span>
          <span className="muted">limits: depth {s.depth}, {s.max_queries} queries, {s.max_results} results</span>
          <span className="muted">sources: {s.source_ids.join(', ')}</span>
          {s.results_count > 0 ? <Link to={`/?sessionId=${s.id}&status=discovered,saved,approved_consideration,rejected,archived`}>View results in RADAR →</Link> : null}
        </div>
        {s.error_summary ? <div className="notice danger small">{s.error_summary}</div> : null}
        {q.data.queries.length === 0 ? <p className="small muted">{ACTIVE.includes(s.status) ? 'Waiting for the worker…' : 'No queries were run.'}</p> : (
          <ul className="qtree">{children(null).map((n) => <Node key={n.id} n={n} />)}</ul>
        )}
      </div>
    </section>
  );
}

function Schedules() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['schedules'], queryFn: () => api.get<Schedule[]>('/api/schedules') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/schedules/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/schedules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });
  const paused = settings.data?.settings.background_paused?.value;
  return (
    <section className="panel">
      <header><h2>Background schedules</h2>{paused ? <span className="badge warn">all paused</span> : null}</header>
      <div className="body">
        {paused ? <p className="notice warn small">Background discovery is paused in <Link to="/settings">Settings</Link>. Schedules will not run.</p> : null}
        {list.data?.length === 0 ? <p className="small muted">No schedules. Background discovery only happens if you create and switch one on.</p> : null}
        {list.data?.map((s) => (
          <div key={s.id} className="row between" style={{ borderTop: '1px solid var(--rule)', padding: '6px 0' }}>
            <div>
              <b>{s.name}</b> <span className="small muted">“{s.params.query}” · {s.params.mode} · every {s.interval_minutes >= 1440 ? `${s.interval_minutes / 1440}d` : `${s.interval_minutes / 60}h`} · ≤{s.max_runs_per_day}/day</span>
              <div className="small muted">Last run {fmtDateTime(s.last_run_at)} · next {s.enabled ? fmtDateTime(s.next_run_at) : '—'}</div>
            </div>
            <div className="row tight">
              <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => toggle.mutate({ id: s.id, enabled: e.target.checked })} /> On</label>
              <button className="sm ghost" onClick={() => window.confirm(`Delete schedule “${s.name}”?`) && del.mutate(s.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
