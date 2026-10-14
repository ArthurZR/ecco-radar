import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { STATUS_LABEL, type FeedResponse, type Status } from '../lib/types';
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format';
import { Empty, ErrorBox, Loading, PageHead, Seg, StatusBadge, Thumb } from '../components/ui';

interface Decisions {
  decisions: { id: string; decision_type: string; reason_code: string | null; reason_scope: string | null; notes: string | null; previous_status: string | null; new_status: string | null; created_at: string; ref_number: number; title: string | null; creator_name: string | null; source_id: string }[];
  summary: { new_status: string; reason_code: string | null; reason_scope: string | null; n: number }[];
}

const ALL = Object.keys(STATUS_LABEL) as Status[];

export function ArchivePage() {
  const [view, setView] = useState<'items' | 'decisions'>('items');
  return (
    <>
      <PageHead title="Archive" sub="Every reference and every decision, permanently numbered">
        <Seg label="View" value={view} onChange={setView} options={[{ value: 'items', label: 'References' }, { value: 'decisions', label: 'Decision history' }]} />
      </PageHead>
      <div className="content">{view === 'items' ? <Items /> : <DecisionHistory />}</div>
    </>
  );
}

function Items() {
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [deleted, setDeleted] = useState(false);
  const facets = useQuery({ queryKey: ['facets'], queryFn: () => api.get<{ statuses: { status: Status; n: number }[] }>('/api/references-facets') });
  const list = useInfiniteQuery({
    queryKey: ['archive', status, query, deleted],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<FeedResponse>(`/api/references${qs({ status: status === 'all' ? ALL : [status], q: query, sort: 'ref_number', includeDeleted: deleted || undefined, offset: pageParam, limit: 100 })}`),
    getNextPageParam: (l) => l.nextOffset ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const count = (s: Status) => facets.data?.statuses.find((x) => x.status === s)?.n ?? 0;
  const total = facets.data?.statuses.reduce((a, b) => a + b.n, 0) ?? 0;
  return (
    <div className="stack">
      <div className="row">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Status | 'all')}>
          <option value="all">All statuses ({total})</option>
          {ALL.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]} ({count(s)})</option>)}
        </select>
        <form className="row tight" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search or #ID" aria-label="Search archive" />
          <button className="sm" type="submit">Search</button>
        </form>
        <label className="check"><input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} /> Include deleted</label>
        <span className="small muted">{list.data ? `${fmtNum(list.data.pages[0]?.total)} shown by ID` : ''}</span>
      </div>
      <ErrorBox error={list.error} retry={() => list.refetch()} />
      {list.isLoading ? <Loading /> : null}
      {!list.isLoading && items.length === 0 ? <Empty title="No references">Nothing matches.</Empty> : null}
      {items.length ? (
        <div className="scroll-x panel">
          <table className="data">
            <thead><tr><th>ID</th><th style={{ width: 52 }} /><th>Title</th><th>Creator</th><th>Date</th><th>Source</th><th>Status</th><th>Found</th></tr></thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td><Link className="refid" to={`/ref/${it.refNumber}`}>{it.refLabel}</Link></td>
                  <td><Link to={`/ref/${it.refNumber}`} tabIndex={-1} style={{ display: 'block', width: 44, height: 44, overflow: 'hidden', background: 'var(--panel-2)' }}><Thumb src={it.thumbnailUrl ?? it.previewUrl} alt="" className="archthumb" /></Link></td>
                  <td>{it.title ?? <span className="muted">Untitled</span>}{it.duplicateCandidates ? <span className="badge warn" style={{ marginLeft: 4 }}>dup?</span> : null}</td>
                  <td>{it.creatorName ?? <span className="muted">Unknown</span>}</td>
                  <td className="small">{it.publishedRaw ?? '—'}</td>
                  <td className="small">{it.sourceName}</td>
                  <td><StatusBadge status={it.status} /></td>
                  <td className="small nowrap">{fmtDate(it.discoveredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? <div><button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div> : null}
    </div>
  );
}

function DecisionHistory() {
  const q = useQuery({ queryKey: ['decisions'], queryFn: () => api.get<Decisions>('/api/decisions?limit=300') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const rejections = q.data.summary.filter((s) => s.new_status === 'rejected');
  const byStatus = new Map<string, number>();
  for (const s of q.data.summary) byStatus.set(s.new_status, (byStatus.get(s.new_status) ?? 0) + s.n);
  return (
    <div className="grid2">
      <section className="panel">
        <header><h2>Recent decisions</h2><span className="small muted">latest 300</span></header>
        <div className="body scroll-x">
          {q.data.decisions.length === 0 ? <Empty title="No decisions yet">Save, approve or reject references in RADAR.</Empty> : (
            <table className="data">
              <thead><tr><th>When</th><th>Ref</th><th>Decision</th><th>Reason</th></tr></thead>
              <tbody>
                {q.data.decisions.map((d) => (
                  <tr key={d.id}>
                    <td className="small nowrap">{fmtDateTime(d.created_at)}</td>
                    <td><Link className="refid" to={`/ref/${d.ref_number}`}>#{String(d.ref_number).padStart(5, '0')}</Link><div className="small muted">{d.title?.slice(0, 60)}</div></td>
                    <td className="small">{d.decision_type === 'status_change' ? <>{d.previous_status ? STATUS_LABEL[d.previous_status as Status] : '—'} → <b>{STATUS_LABEL[d.new_status as Status] ?? d.new_status}</b></> : d.decision_type.replace(/_/g, ' ')}</td>
                    <td className="small">{d.reason_code ? `${d.reason_code.replace(/_/g, ' ')}${d.reason_scope ? ` (${d.reason_scope})` : ''}` : ''}{d.notes ? <div className="muted">{d.notes}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <div className="stack lg">
        <section className="panel">
          <header><h2>Status changes, all time</h2></header>
          <div className="body">
            <table className="data"><tbody>{[...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => <tr key={s}><td>{STATUS_LABEL[s as Status] ?? s}</td><td className="num">{n}</td></tr>)}</tbody></table>
          </div>
        </section>
        <section className="panel">
          <header><h2>Rejection reasons</h2></header>
          <div className="body">
            {rejections.length === 0 ? <p className="small muted">No rejections yet.</p> : (
              <table className="data"><thead><tr><th>Reason</th><th>Scope</th><th className="num">n</th></tr></thead>
                <tbody>{rejections.map((r, i) => <tr key={i}><td>{r.reason_code?.replace(/_/g, ' ') ?? 'unspecified'}</td><td className="small">{r.reason_scope ?? 'item'}</td><td className="num">{r.n}</td></tr>)}</tbody>
              </table>
            )}
            <p className="small muted" style={{ marginTop: 6 }}>Topic, creator and source rejections shape ranking more strongly than item rejections. See learned preferences in Settings.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
