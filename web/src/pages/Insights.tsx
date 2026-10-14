import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, fmtNum, fmtPct } from '../lib/format';
import { Empty, ErrorBox, Loading, PageHead, Seg, errorText, useToast } from '../components/ui';
import { LineChart } from '../components/charts';

interface Summary { n: number; median: number | null; p25: number | null; p75: number | null; min: number | null; max: number | null }
type Group = Summary & { key: string };
interface Overview {
  postLevel: { platform: string; account_handle: string; posts: number; first: string | null; last: string | null; with_media: number }[];
  accountDaily: { platform: string; account_handle: string; days: number; first: string; last: string; metrics: string[] }[];
  metricCoverage: { platform: string; metric: string; posts: number }[];
  batches: { committed: number; rolled_back: number };
}
interface IgPost { id: string; caption: string | null; permalink: string | null; format: string | null; publishedAt: string | null; rate: number; metrics: Record<string, number> }
interface Instagram {
  posts: number; definitions: Record<string, string>; metrics: Record<string, Summary>;
  engagementPerReach: Summary; savesPerReach: Summary; sharesPerReach: Summary;
  byFormat: Group[]; byCaptionLength: Group[]; byHashtag: Group[]; byTerm: Group[]; byPeriodMentioned: Group[]; monthly: Group[];
  top: IgPost[]; bottom: IgPost[]; visualAnalysis: string;
}
interface XDaily { note: string; metrics: string[]; days: ({ date: string } & Record<string, number>)[]; weekly: ({ week: string; days: number } & Record<string, number>)[]; totals: Record<string, Summary> }

type Tab = 'overview' | 'instagram' | 'x' | 'editorial' | 'imports';

export function InsightsPage() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <>
      <PageHead title="Insights" sub="Descriptive patterns from your own exports and decisions">
        <Seg label="Section" value={tab} onChange={setTab} options={[
          { value: 'overview', label: 'Overview' }, { value: 'instagram', label: 'Instagram posts' }, { value: 'x', label: 'X daily' },
          { value: 'editorial', label: 'Editorial' }, { value: 'imports', label: 'Imports' },
        ]} />
      </PageHead>
      <div className="content">
        {tab === 'overview' ? <OverviewTab go={setTab} /> : null}
        {tab === 'instagram' ? <InstagramTab /> : null}
        {tab === 'x' ? <XTab /> : null}
        {tab === 'editorial' ? <EditorialTab /> : null}
        {tab === 'imports' ? <ImportsTab /> : null}
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="stat"><div className="l">{label}</div><div className="v">{value}</div>{sub ? <div className="small muted">{sub}</div> : null}</div>;
}

function OverviewTab({ go }: { go: (t: Tab) => void }) {
  const q = useQuery({ queryKey: ['insights', 'overview'], queryFn: () => api.get<Overview>('/api/insights/overview') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  if (!d.postLevel.length && !d.accountDaily.length) {
    return (
      <Empty title="No analytics imported">
        <p>Import your Instagram post export or X account overview CSV to see patterns. Files are parsed on the server and never sent to an AI provider.</p>
        <button className="primary" onClick={() => go('imports')}>Import a CSV</button>
      </Empty>
    );
  }
  return (
    <div className="stack lg">
      <div className="grid2">
        <section className="panel">
          <header><h2>Post-level data</h2></header>
          <div className="body">
            {d.postLevel.length === 0 ? <p className="small muted">None imported.</p> : (
              <table className="data"><thead><tr><th>Platform</th><th>Account</th><th className="num">Posts</th><th>Range</th></tr></thead>
                <tbody>{d.postLevel.map((p) => <tr key={p.platform + p.account_handle}><td>{p.platform}</td><td className="mono">{p.account_handle}</td><td className="num">{p.posts}</td><td className="small">{fmtDate(p.first)} – {fmtDate(p.last)}</td></tr>)}</tbody>
              </table>
            )}
            <p className="small muted" style={{ marginTop: 6 }}>Each row is one post with its own metrics.</p>
          </div>
        </section>
        <section className="panel">
          <header><h2>Account-level daily totals</h2></header>
          <div className="body">
            {d.accountDaily.length === 0 ? <p className="small muted">None imported.</p> : (
              <table className="data"><thead><tr><th>Platform</th><th>Account</th><th className="num">Days</th><th>Range</th></tr></thead>
                <tbody>{d.accountDaily.map((p) => <tr key={p.platform + p.account_handle}><td>{p.platform}</td><td className="mono">{p.account_handle}</td><td className="num">{p.days}</td><td className="small">{p.first} – {p.last}</td></tr>)}</tbody>
              </table>
            )}
            <p className="small muted" style={{ marginTop: 6 }}>Totals for the whole account per day. They are never attributed to individual posts.</p>
          </div>
        </section>
      </div>
      <section className="panel">
        <header><h2>Metric coverage</h2><span className="small muted">{d.batches.committed} committed import(s), {d.batches.rolled_back} rolled back</span></header>
        <div className="body">
          {d.metricCoverage.length === 0 ? <p className="small muted">No post-level metrics.</p> : (
            <div className="row">{d.metricCoverage.map((m) => <span key={m.platform + m.metric} className="badge">{m.platform} · {m.metric}: {m.posts} posts</span>)}</div>
          )}
          <p className="small muted" style={{ marginTop: 6 }}>Metrics missing from an export are stored as missing, not zero.</p>
        </div>
      </section>
    </div>
  );
}

function GroupTable({ title, groups, note }: { title: string; groups: Group[]; note?: string }) {
  return (
    <section className="panel">
      <header><h3>{title}</h3></header>
      <div className="body">
        {groups.length === 0 ? <p className="small muted">No group has at least 5 posts with reach data.</p> : (
          <table className="data">
            <thead><tr><th>Group</th><th className="num">Posts</th><th className="num">Median</th><th className="num">IQR</th></tr></thead>
            <tbody>{groups.map((g) => <tr key={g.key}><td>{g.key}</td><td className="num">{g.n}</td><td className="num">{fmtPct(g.median, 2)}</td><td className="num small">{fmtPct(g.p25, 2)}–{fmtPct(g.p75, 2)}</td></tr>)}</tbody>
          </table>
        )}
        {note ? <p className="small muted" style={{ marginTop: 6 }}>{note}</p> : null}
      </div>
    </section>
  );
}

function InstagramTab() {
  const q = useQuery({ queryKey: ['insights', 'instagram'], queryFn: () => api.get<Instagram>('/api/insights/instagram') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  if (d.posts === 0) return <Empty title="No Instagram posts imported">Use Imports to add your Instagram post export.</Empty>;
  return (
    <div className="stack lg">
      <div className="grid3">
        <Stat label="Posts" value={fmtNum(d.posts)} />
        <Stat label="Median engagement ÷ reach" value={fmtPct(d.engagementPerReach.median, 2)} sub={`IQR ${fmtPct(d.engagementPerReach.p25, 2)}–${fmtPct(d.engagementPerReach.p75, 2)} · n=${d.engagementPerReach.n}`} />
        <Stat label="Median saves ÷ reach" value={fmtPct(d.savesPerReach.median, 2)} sub={`n=${d.savesPerReach.n}`} />
        <Stat label="Median shares ÷ reach" value={fmtPct(d.sharesPerReach.median, 2)} sub={`n=${d.sharesPerReach.n}`} />
      </div>
      <div className="notice small">
        {Object.entries(d.definitions).map(([k, v]) => <div key={k}><b>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}:</b> {v}</div>)}
      </div>
      <section className="panel">
        <header><h3>Monthly median engagement ÷ reach</h3></header>
        <div className="body">
          <LineChart title="Median engagement ÷ reach per month, with interquartile band" band points={d.monthly.map((m) => ({ x: m.key, y: m.median, lo: m.p25, hi: m.p75, n: m.n }))} format={(v) => fmtPct(v, 1)} />
        </div>
      </section>
      <div className="grid2">
        <GroupTable title="By format" groups={d.byFormat} />
        <GroupTable title="By caption length" groups={d.byCaptionLength} />
        <GroupTable title="By hashtag" groups={d.byHashtag} />
        <GroupTable title="By caption term" groups={d.byTerm} note="Terms are words in captions; they describe what eccö wrote about, not what the images show." />
        <GroupTable title="By period mentioned" groups={d.byPeriodMentioned} note="Decades or years mentioned in the caption text." />
        <section className="panel">
          <header><h3>Metric summaries</h3></header>
          <div className="body">
            <table className="data"><thead><tr><th>Metric</th><th className="num">Posts</th><th className="num">Median</th><th className="num">IQR</th></tr></thead>
              <tbody>{Object.entries(d.metrics).map(([k, s]) => <tr key={k}><td>{k}</td><td className="num">{s.n}</td><td className="num">{fmtNum(s.median)}</td><td className="num small">{fmtNum(s.p25)}–{fmtNum(s.p75)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      </div>
      <div className="grid2">
        <PostTable title="Highest engagement ÷ reach" posts={d.top} />
        <PostTable title="Lowest engagement ÷ reach" posts={d.bottom} />
      </div>
      <p className="notice small">{d.visualAnalysis} These patterns are associations within eccö’s own history, not causes.</p>
    </div>
  );
}

function PostTable({ title, posts }: { title: string; posts: IgPost[] }) {
  return (
    <section className="panel">
      <header><h3>{title}</h3><span className="small muted">reach ≥ 100</span></header>
      <div className="body scroll-x">
        <table className="data">
          <thead><tr><th>Date</th><th>Caption</th><th className="num">Rate</th><th className="num">Reach</th></tr></thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <td className="small nowrap">{fmtDate(p.publishedAt)}</td>
                <td className="small">{p.permalink ? <a href={p.permalink} target="_blank" rel="noopener noreferrer">{(p.caption ?? '(no caption)').slice(0, 90)}</a> : (p.caption ?? '').slice(0, 90)}{p.format ? <span className="muted"> · {p.format}</span> : null}</td>
                <td className="num">{fmtPct(p.rate, 2)}</td>
                <td className="num">{fmtNum(p.metrics.reach)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function XTab() {
  const q = useQuery({ queryKey: ['insights', 'x'], queryFn: () => api.get<XDaily>('/api/insights/x-daily') });
  const [metric, setMetric] = useState<string>('');
  const [grain, setGrain] = useState<'day' | 'week'>('week');
  const d = q.data;
  const m = metric || (d?.metrics.includes('impressions') ? 'impressions' : d?.metrics[0] ?? '');
  const points = useMemo(() => {
    if (!d) return [];
    return grain === 'day'
      ? d.days.map((x) => ({ x: x.date, y: typeof x[m] === 'number' ? x[m] : null }))
      : d.weekly.map((x) => ({ x: x.week, y: typeof x[m] === 'number' ? x[m] : null, n: x.days }));
  }, [d, m, grain]);
  if (q.isLoading) return <Loading />;
  if (q.error || !d) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  if (!d.days.length) return <Empty title="No X account data imported">Use Imports to add your X account overview CSV.</Empty>;
  return (
    <div className="stack lg">
      <div className="notice warn small">{d.note}</div>
      <div className="row">
        <label className="field"><span>Metric</span>
          <select value={m} onChange={(e) => setMetric(e.target.value)}>{d.metrics.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}</select>
        </label>
        <Seg label="Grain" value={grain} onChange={setGrain} options={[{ value: 'week', label: 'Weekly totals' }, { value: 'day', label: 'Daily' }]} />
        <span className="small muted">{d.days.length} days · {d.days[0]?.date} – {d.days[d.days.length - 1]?.date}</span>
      </div>
      <section className="panel">
        <div className="body">
          <LineChart title={`${m.replace(/_/g, ' ')}: ${grain === 'week' ? 'weekly total (weeks start Monday)' : 'daily total'}, whole account`} points={points} format={(v) => fmtNum(v)} xLabel={(x) => x.slice(0, 10)} nLabel="days" />
          {grain === 'week' ? <p className="small muted">Partial weeks at the start or end have fewer days; the table view shows the day count.</p> : null}
        </div>
      </section>
      <section className="panel">
        <header><h3>Daily distribution</h3></header>
        <div className="body scroll-x">
          <table className="data"><thead><tr><th>Metric</th><th className="num">Days</th><th className="num">Median/day</th><th className="num">IQR</th><th className="num">Max</th></tr></thead>
            <tbody>{Object.entries(d.totals).map(([k, s]) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td className="num">{s.n}</td><td className="num">{fmtNum(s.median)}</td><td className="num small">{fmtNum(s.p25)}–{fmtNum(s.p75)}</td><td className="num">{fmtNum(s.max)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function EditorialTab() {
  const q = useQuery({
    queryKey: ['insights', 'editorial'],
    queryFn: () => api.get<{ bySource: { source_id: string; decided: number; approved: number; rejected: number }[]; rejectionReasons: { reason: string; scope: string; n: number }[]; statusCounts: { status: string; n: number }[] }>('/api/insights/editorial'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  return (
    <div className="grid2">
      <section className="panel">
        <header><h3>Decisions by source</h3></header>
        <div className="body">
          {d.bySource.length === 0 ? <p className="small muted">No decisions yet.</p> : (
            <table className="data"><thead><tr><th>Source</th><th className="num">Decided</th><th className="num">Approved+</th><th className="num">Rejected</th><th className="num">Approval rate</th></tr></thead>
              <tbody>{d.bySource.map((s) => <tr key={s.source_id}><td>{s.source_id}</td><td className="num">{s.decided}</td><td className="num">{s.approved}</td><td className="num">{s.rejected}</td><td className="num">{s.decided >= 5 ? fmtPct(s.approved / s.decided, 0) : <span className="muted" title="Fewer than 5 decisions">—</span>}</td></tr>)}</tbody>
            </table>
          )}
          <p className="small muted" style={{ marginTop: 6 }}>Latest decision per reference. “Approved+” counts anything from editorial consideration onward.</p>
        </div>
      </section>
      <section className="panel">
        <header><h3>Rejection reasons</h3></header>
        <div className="body">
          {d.rejectionReasons.length === 0 ? <p className="small muted">No rejections yet.</p> : (
            <table className="data"><tbody>{d.rejectionReasons.map((r, i) => <tr key={i}><td>{r.reason.replace(/_/g, ' ')}</td><td className="small">{r.scope}</td><td className="num">{r.n}</td></tr>)}</tbody></table>
          )}
        </div>
      </section>
      <section className="panel">
        <header><h3>Archive by status</h3></header>
        <div className="body">
          <table className="data"><tbody>{d.statusCounts.map((s) => <tr key={s.status}><td>{s.status.replace(/_/g, ' ')}</td><td className="num">{s.n}</td></tr>)}</tbody></table>
          <p className="small"><Link to="/archive">Open the archive →</Link></p>
        </div>
      </section>
    </div>
  );
}

/* ---------------- Imports ---------------- */

type Kind = 'instagram_posts' | 'x_account_daily' | 'x_posts';
interface Inspect {
  filename: string; sha256: string; delimiter: string; headers: string[]; rowCount: number; sample: Record<string, string>[];
  detected: { kind: Kind | null; reason: string }; suggestions: Record<Kind, Record<string, string>>; fields: Record<Kind, string[]>;
  accounts: { account: string; rows: number }[]; dateOrder: 'MDY' | 'DMY' | 'ISO' | null;
  alreadyImported: { id: string; created_at: string; status: string }[];
}
interface Preview {
  summary: { total: number; valid: number; skippedAccount: number; duplicates: number; invalid: number; newRecords: number; existingRecords: number; dateRange: { from: string | null; to: string | null }; metricsPresent: string[] };
  warnings: string[];
  problems: { row: number; errors: string[] }[];
  sample: { row: number; outcome: string; post?: Record<string, unknown>; daily?: { date: string; metrics: Record<string, number> } }[];
}
interface Batch { id: string; kind: Kind; filename: string; account_filter: string | null; row_count: number; imported_count: number; skipped_count: number; duplicate_count: number; invalid_count: number; status: string; created_at: string; rolled_back_at: string | null }

const KIND_LABEL: Record<Kind, string> = { instagram_posts: 'Instagram posts (one row per post)', x_account_daily: 'X account overview (one row per day)', x_posts: 'X posts (one row per post)' };

function ImportsTab() {
  return (
    <div className="stack lg">
      <ImportWizard />
      <Batches />
    </div>
  );
}

function ImportWizard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [kind, setKind] = useState<Kind | ''>('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [account, setAccount] = useState('');
  const [dateOrder, setDateOrder] = useState<'auto' | 'MDY' | 'DMY' | 'ISO'>('auto');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reset = () => { setFile(null); setInfo(null); setKind(''); setMapping({}); setAccount(''); setPreview(null); setError(null); setDateOrder('auto'); };
  const form = (withOptions: boolean) => {
    const f = new FormData();
    if (withOptions) f.append('options', JSON.stringify({ kind, mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)), dateOrder, account: account || undefined }));
    f.append('file', file!);
    return f;
  };
  const inspect = async (f: File) => {
    setFile(f); setInfo(null); setPreview(null); setError(null); setBusy('inspect');
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await api.post<Inspect>('/api/imports/inspect', fd);
      setInfo(r);
      const k = r.detected.kind ?? '';
      setKind(k);
      setMapping(k ? r.suggestions[k] : {});
      setAccount(k === 'instagram_posts' ? r.accounts[0]?.account ?? '' : '');
      setDateOrder(r.dateOrder ? 'auto' : 'auto');
    } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const doPreview = async () => {
    setBusy('preview'); setError(null); setPreview(null);
    try { setPreview(await api.post<Preview>('/api/imports/preview', form(true))); } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const commit = useMutation({
    mutationFn: () => api.post<{ batchId: string; summary: Preview['summary'] }>('/api/imports/commit', form(true)),
    onSuccess: (r) => {
      toast({ text: `Imported ${r.summary.newRecords} new record(s)` });
      qc.invalidateQueries({ queryKey: ['imports'] });
      qc.invalidateQueries({ queryKey: ['insights'] });
      reset();
    },
    onError: (e) => setError(e),
  });

  const ambiguous = info && info.dateOrder === null;
  const needsAccount = kind !== '';
  return (
    <section className="panel">
      <header><h2>Import a CSV</h2>{info ? <button className="sm ghost" onClick={reset}>Start over</button> : null}</header>
      <div className="body stack">
        <p className="small muted">The file is read on the server, validated, and kept as raw rows for audit. You see a preview before anything is saved, and every import can be rolled back. Analytics files are never sent to an AI provider.</p>
        <label className="field"><span>1 · File</span>
          <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => e.target.files?.[0] && inspect(e.target.files[0])} />
        </label>
        {busy === 'inspect' ? <Loading label="Reading file" /> : null}
        {info ? (
          <>
            <div className="small">
              <b>{info.filename}</b> · {info.rowCount} rows · {info.headers.length} columns · delimiter “{info.delimiter === '\t' ? 'tab' : info.delimiter}”
              <div className="muted">{info.detected.reason}</div>
            </div>
            {info.alreadyImported.length ? (
              <div className="notice warn small">This exact file was imported before ({info.alreadyImported.map((b) => `${fmtDateTime(b.created_at)}, ${b.status}`).join('; ')}). A committed file cannot be imported twice; roll back the earlier batch first.</div>
            ) : null}
            <label className="field"><span>2 · What is this file?</span>
              <select value={kind} onChange={(e) => { const k = e.target.value as Kind | ''; setKind(k); setMapping(k ? info.suggestions[k] : {}); setPreview(null); }}>
                <option value="">Choose…</option>
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            {kind ? (
              <>
                <div>
                  <div className="small" style={{ marginBottom: 4 }}><b>3 · Columns</b> <span className="muted">Suggested from header names. Unmapped metrics are treated as missing, not zero.</span></div>
                  <div className="grid3" style={{ gap: 6 }}>
                    {info.fields[kind].map((f) => (
                      <label key={f} className="field"><span>{f.replace(/_/g, ' ')}</span>
                        <select value={mapping[f] ?? ''} onChange={(e) => { setMapping({ ...mapping, [f]: e.target.value }); setPreview(null); }}>
                          <option value="">— not in file —</option>
                          {info.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
                {needsAccount ? (
                  kind === 'instagram_posts' ? (
                    <label className="field"><span>4 · Account to import</span>
                      <select value={account} onChange={(e) => { setAccount(e.target.value); setPreview(null); }}>
                        <option value="">Choose…</option>
                        {info.accounts.map((a) => <option key={a.account} value={a.account}>{a.account} ({a.rows} rows)</option>)}
                      </select>
                      <small className="muted">Rows from other accounts are skipped and reported.</small>
                    </label>
                  ) : (
                    <label className="field"><span>4 · X account this file belongs to</span>
                      <input value={account} onChange={(e) => { setAccount(e.target.value); setPreview(null); }} placeholder="handle without @" />
                    </label>
                  )
                ) : null}
                <label className="field"><span>5 · Date format</span>
                  <select value={dateOrder} onChange={(e) => { setDateOrder(e.target.value as typeof dateOrder); setPreview(null); }}>
                    <option value="auto">Detect{info.dateOrder ? ` (found ${info.dateOrder})` : ' (ambiguous: choose)'}</option>
                    <option value="MDY">Month/Day/Year</option>
                    <option value="DMY">Day/Month/Year</option>
                    <option value="ISO">ISO (YYYY-MM-DD)</option>
                  </select>
                  {ambiguous ? <small style={{ color: 'var(--warn)' }}>Every date in this file fits both orders. Choose one; RADAR will not guess.</small> : null}
                </label>
                <div className="row">
                  <button onClick={doPreview} disabled={busy !== null || !account || (!!ambiguous && dateOrder === 'auto')}>{busy === 'preview' ? 'Validating…' : 'Preview import'}</button>
                </div>
              </>
            ) : null}
          </>
        ) : null}
        <ErrorBox error={error} />
        {preview ? (
          <div className="stack">
            <div className="grid3">
              <Stat label="New records" value={fmtNum(preview.summary.newRecords)} />
              <Stat label="Already present" value={fmtNum(preview.summary.existingRecords)} sub="kept as a newer observation" />
              <Stat label="Other accounts skipped" value={fmtNum(preview.summary.skippedAccount)} />
              <Stat label="Invalid rows" value={fmtNum(preview.summary.invalid)} />
            </div>
            <div className="small">Dates: {fmtDate(preview.summary.dateRange.from)} – {fmtDate(preview.summary.dateRange.to)} · Metrics found: {preview.summary.metricsPresent.join(', ') || 'none'}</div>
            {preview.warnings.map((w, i) => <div key={i} className="notice warn small">{w}</div>)}
            {preview.problems.length ? (
              <details>
                <summary className="small">{preview.problems.length} row(s) with problems (they will not be imported)</summary>
                <table className="data"><tbody>{preview.problems.map((p) => <tr key={p.row}><td className="mono">row {p.row}</td><td className="small">{p.errors.join('; ')}</td></tr>)}</tbody></table>
              </details>
            ) : null}
            <details>
              <summary className="small">Sample of normalized rows</summary>
              <pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(preview.sample, null, 1)}</pre>
            </details>
            <div className="row">
              <button className="primary" disabled={commit.isPending || preview.summary.valid === 0} onClick={() => commit.mutate()}>{commit.isPending ? 'Importing…' : `Commit ${preview.summary.valid} row(s)`}</button>
              <button onClick={reset}>Cancel</button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Batches() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['imports'], queryFn: () => api.get<Batch[]>('/api/imports') });
  const [rowsFor, setRowsFor] = useState<string | null>(null);
  const rows = useQuery({
    queryKey: ['imports', rowsFor, 'rows'],
    enabled: !!rowsFor,
    queryFn: () => api.get<{ row_index: number; outcome: string; errors: string[] }[]>(`/api/imports/${rowsFor}/rows?outcome=invalid`),
  });
  const rollback = useMutation({
    mutationFn: (id: string) => api.post(`/api/imports/${id}/rollback`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['imports'] }); qc.invalidateQueries({ queryKey: ['insights'] }); toast({ text: 'Import rolled back' }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/imports/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['imports'] }),
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  return (
    <section className="panel">
      <header><h2>Import history</h2></header>
      <div className="body scroll-x">
        {list.isLoading ? <Loading /> : null}
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <p className="small muted">No imports yet.</p> : null}
        {list.data?.length ? (
          <table className="data">
            <thead><tr><th>When</th><th>File</th><th>Type</th><th>Account</th><th className="num">Rows</th><th className="num">New</th><th className="num">Dup</th><th className="num">Skipped</th><th className="num">Invalid</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((b) => (
                <tr key={b.id}>
                  <td className="small nowrap">{fmtDateTime(b.created_at)}</td>
                  <td className="small">{b.filename}</td>
                  <td className="small">{b.kind.replace(/_/g, ' ')}</td>
                  <td className="mono">{b.account_filter ?? '—'}</td>
                  <td className="num">{b.row_count}</td><td className="num">{b.imported_count}</td><td className="num">{b.duplicate_count}</td><td className="num">{b.skipped_count}</td>
                  <td className="num">{b.invalid_count ? <button className="sm ghost" onClick={() => setRowsFor(rowsFor === b.id ? null : b.id)}>{b.invalid_count}</button> : 0}</td>
                  <td><span className={`badge ${b.status === 'committed' ? 'green' : ''}`}>{b.status.replace('_', ' ')}</span></td>
                  <td className="nowrap right">
                    {b.status === 'committed' ? <button className="sm" onClick={() => window.confirm('Roll back this import? Its posts and metrics are removed; raw rows are kept for audit.') && rollback.mutate(b.id)}>Roll back</button> : null}
                    {b.status === 'rolled_back' ? <button className="sm danger" onClick={() => window.confirm('Delete this batch and its raw rows permanently?') && del.mutate(b.id)}>Delete</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {rowsFor ? (
          <div style={{ marginTop: 10 }}>
            <h3>Invalid rows</h3>
            {rows.isLoading ? <Loading /> : (
              <table className="data"><tbody>{rows.data?.map((r) => <tr key={r.row_index}><td className="mono">row {r.row_index + 2}</td><td className="small">{r.errors.join('; ')}</td></tr>)}</tbody></table>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
