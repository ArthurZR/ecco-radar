import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { SourceInfo } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { ErrorBox, Loading, PageHead, errorText, useToast } from '../components/ui';

interface Feed { id: string; url: string; title: string | null; enabled: boolean; last_fetched_at?: string | null; last_error?: string | null }
interface TestResult { ok: boolean; status: string; error?: string; sample?: { title: string | null; url: string; creator: string | null }[] }

const STATUS_TEXT: Record<string, { label: string; tone: string; help: string }> = {
  active: { label: 'verified', tone: 'green', help: 'A live request succeeded.' },
  unverified: { label: 'unverified', tone: 'warn', help: 'Built and tested against recorded API shapes, but no live request has succeeded from this server yet. Use Test.' },
  needs_configuration: { label: 'needs key', tone: 'warn', help: 'Requires credentials in the server environment.' },
  rate_limited: { label: 'rate limited', tone: 'warn', help: 'The source asked RADAR to slow down.' },
  unavailable: { label: 'unavailable', tone: 'danger', help: 'The last request failed.' },
  disabled: { label: 'disabled', tone: '', help: 'Switched off.' },
};

export function SourcesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[]; feeds: Feed[] }>('/api/sources') });
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({});
  const enable = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/sources/${id}`, { enabled }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sources'] }); qc.invalidateQueries({ queryKey: ['exploration-options'] }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: 'running' }));
    try {
      const r = await api.post<TestResult>(`/api/sources/${id}/test`, { query: 'poster' });
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, status: 'error', error: errorText(e) } }));
    }
    qc.invalidateQueries({ queryKey: ['sources'] });
  };

  return (
    <>
      <PageHead title="Sources" sub="Where RADAR looks, and whether each connection is proven" />
      <div className="content stack lg">
        <p className="small muted">RADAR uses official APIs and open feeds only. It never bypasses logins, paywalls, CAPTCHAs or rate limits, and does not scrape Instagram. A source is marked <b>verified</b> only after a live request from this server succeeds.</p>
        {q.isLoading ? <Loading /> : null}
        <ErrorBox error={q.error} retry={() => q.refetch()} />
        <div className="grid2">
          {q.data?.sources.map((s) => {
            const st = STATUS_TEXT[s.status] ?? { label: s.status, tone: '', help: '' };
            const t = tests[s.id];
            return (
              <section key={s.id} className="panel">
                <header>
                  <h2>{s.name}</h2>
                  <span className={`badge ${st.tone}`} title={st.help}>{st.label}</span>
                </header>
                <div className="body stack">
                  <p className="small">{s.accessNotes}</p>
                  <dl className="kv small">
                    <dt>Type</dt><dd>{s.connector_type}{s.searchable ? ' · searchable' : ''}</dd>
                    <dt>Capabilities</dt><dd>{Object.entries(s.capabilities).filter(([, v]) => v).map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ') || '—'}</dd>
                    <dt>References</dt><dd>{s.referenceCount}</dd>
                    <dt>Rate limit</dt><dd>{s.rate_limit_per_minute}/min (self-imposed)</dd>
                    <dt>Last success</dt><dd>{fmtDateTime(s.last_success_at)}</dd>
                    {s.last_error ? (<><dt>Last error</dt><dd style={{ color: 'var(--danger)' }}>{s.last_error} <span className="muted">({fmtDateTime(s.last_error_at)})</span></dd></>) : null}
                    {s.rate_limited_until ? (<><dt>Paused until</dt><dd>{fmtDateTime(s.rate_limited_until)}</dd></>) : null}
                    {s.attribution_requirements ? (<><dt>Attribution</dt><dd>{s.attribution_requirements}</dd></>) : null}
                    {s.terms_url ? (<><dt>Terms</dt><dd><a href={s.terms_url} target="_blank" rel="noopener noreferrer">{s.terms_url}</a></dd></>) : null}
                  </dl>
                  {s.missingConfiguration.length ? (
                    <div className="notice warn small">Set <code>{s.missingConfiguration.join(', ')}</code> in the server environment (never in the browser) and restart. See README → Source credentials.</div>
                  ) : null}
                  <div className="row">
                    <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => enable.mutate({ id: s.id, enabled: e.target.checked })} /> Enabled</label>
                    {s.searchable ? (
                      <button className="sm" disabled={!s.enabled || s.missingConfiguration.length > 0 || t === 'running'} title={s.missingConfiguration.length ? 'Configure credentials first' : !s.enabled ? 'Enable the source first' : 'Run one small live search'} onClick={() => test(s.id)}>
                        {t === 'running' ? 'Testing…' : 'Test connection'}
                      </button>
                    ) : null}
                  </div>
                  {t && t !== 'running' ? (
                    t.ok ? (
                      <div className="notice ok small">
                        Live request succeeded. Sample: {t.sample?.length ? t.sample.map((x, i) => <span key={i}>{i ? '; ' : ''}<a href={x.url} target="_blank" rel="noopener noreferrer">{x.title ?? x.url}</a></span>) : 'no results for “poster”.'}
                      </div>
                    ) : (
                      <div className="notice danger small">Test failed ({t.status}): {t.error ?? 'no detail'}. The source stays unverified.</div>
                    )
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
        <div className="grid2">
          <RssFeeds feeds={q.data?.feeds ?? []} />
          <UrlImport />
        </div>
      </div>
    </>
  );
}

function RssFeeds({ feeds }: { feeds: Feed[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const add = useMutation({
    mutationFn: () => api.post<Feed>('/api/sources/rss/feeds', { url }),
    onSuccess: (f) => { qc.invalidateQueries({ queryKey: ['sources'] }); setUrl(''); toast({ text: `Feed added: ${f.title ?? f.url}` }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/sources/rss/feeds/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources'] }),
  });
  return (
    <section className="panel">
      <header><h2>RSS / Atom feeds</h2></header>
      <div className="body stack">
        <p className="small muted">Blogs, museums and archives you trust. A feed is fetched once to check it is valid before it is saved. Explorations search the latest entries of enabled feeds.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <input className="grow" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.org/feed.xml" aria-label="Feed URL" />
          <button type="submit" disabled={!url || add.isPending}>{add.isPending ? 'Checking…' : 'Add feed'}</button>
        </form>
        {feeds.length === 0 ? <p className="small muted">No feeds yet.</p> : (
          <table className="data"><tbody>
            {feeds.map((f) => (
              <tr key={f.id}>
                <td>{f.title ?? '—'}<div className="small muted">{f.url}</div>{f.last_error ? <div className="small" style={{ color: 'var(--danger)' }}>{f.last_error}</div> : null}</td>
                <td className="right"><button className="sm ghost" onClick={() => del.mutate(f.id)}>Remove</button></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
    </section>
  );
}

function UrlImport() {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<{ refLabel: string; refNumber: number; created: boolean; note?: string } | null>(null);
  const imp = useMutation({
    mutationFn: () => api.post<{ refLabel: string; refNumber: number; created: boolean; note?: string }>('/api/import-url', { url, note: note || undefined }),
    onSuccess: (r) => { setResult(r); setUrl(''); setNote(''); qc.invalidateQueries({ queryKey: ['feed'] }); qc.invalidateQueries({ queryKey: ['facets'] }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  return (
    <section className="panel">
      <header><h2>Import from URL</h2></header>
      <div className="body stack">
        <p className="small muted">Adds one public page as a reference using the page’s own title, description and preview image. Private or local addresses are refused.</p>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); imp.mutate(); }}>
          <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label="Page URL" />
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you are adding it (optional, saved as a research note)" aria-label="Note" />
          <div><button className="primary" type="submit" disabled={!url || imp.isPending}>{imp.isPending ? 'Reading page…' : 'Import'}</button></div>
        </form>
        {result ? (
          <div className="notice ok small">
            {result.created ? 'Added as ' : 'Already in the archive as '}<Link className="refid" to={`/ref/${result.refNumber}`}>{result.refLabel}</Link>.{result.note ? ` ${result.note}` : ''}
          </div>
        ) : null}
      </div>
    </section>
  );
}
