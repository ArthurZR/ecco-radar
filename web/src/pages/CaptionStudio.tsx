import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { STATUS_LABEL, type FeedResponse, type Status } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { wordDiff } from '../lib/diff';
import { Empty, ErrorBox, Loading, PageHead, StatusBadge, Thumb, errorText, useToast } from '../components/ui';
import { PublishedDialog, useStatusChange } from '../components/StatusActions';

interface Fact { key: string; label: string; value: string; basis: string; sourceUrl?: string }
interface Flag { claim: string; reason: string }
interface Draft {
  id: string; version: number; parent_draft_id: string | null; body: string; origin: string; provider: string | null; model: string | null;
  length_setting: string | null; purpose: string | null; tone: string | null; factual_density: string | null; emphasis: string | null;
  verification_flags: Flag[]; created_at: string;
}
interface Context {
  factSheet: { facts: Fact[]; unknown: string[] };
  drafts: Draft[];
  finalCaption: { body: string; based_on_draft_id: string | null; updated_at: string } | null;
  researchSources: { id: string; url: string; title: string | null; publisher: string | null; excerpt: string | null; added_by: string }[];
  ai: { available: true; provider: string; model: string } | { available: false; reason: string };
}

const PIPELINE: Status[] = ['approved_consideration', 'caption_draft', 'reviewed', 'approved_publication'];
const BASIS: Record<string, string> = { source_metadata: 'source', editor_confirmed: 'confirmed by you', editor_note: 'your note', documented_relation: 'documented' };
const ORIGIN: Record<string, string> = { ai_generated: 'AI draft', grounded_template: 'Assembled from facts', editor_written: 'Written by editor', editor_edited: 'Edited by editor' };

export function CaptionStudioPage() {
  const { ref } = useParams();
  return (
    <>
      <PageHead title="Caption Studio" sub={ref ? `#${ref.padStart(5, '0')}` : 'Grounded drafts; final text is always yours'} />
      <div className="content">{ref ? <Studio refId={ref} /> : <Picker />}</div>
    </>
  );
}

function Picker() {
  const nav = useNavigate();
  const [id, setId] = useState('');
  const list = useQuery({
    queryKey: ['feed', 'studio-picker'],
    queryFn: () => api.get<FeedResponse>(`/api/references${qs({ status: PIPELINE, sort: 'recent', limit: 100 })}`),
  });
  return (
    <div className="stack lg">
      <form className="row" onSubmit={(e) => { e.preventDefault(); const n = id.replace(/\D/g, ''); if (n) nav(`/studio/${n}`); }}>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="#00042" aria-label="Reference ID" style={{ width: 120 }} />
        <button type="submit" disabled={!id.replace(/\D/g, '')}>Open</button>
      </form>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : null}
      {list.data?.items.length === 0 ? <Empty title="Nothing in the caption pipeline">Approve a reference for editorial consideration in RADAR, then open it here.</Empty> : null}
      {PIPELINE.map((s) => {
        const items = list.data?.items.filter((i) => i.status === s) ?? [];
        if (!items.length) return null;
        return (
          <section key={s} className="panel">
            <header><h2>{STATUS_LABEL[s]}</h2><span className="small muted">{items.length}</span></header>
            <div className="body minirefs" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
              {items.map((i) => (
                <Link key={i.id} className="miniref" to={`/studio/${i.refNumber}`}>
                  <Thumb src={i.thumbnailUrl ?? i.previewUrl} alt={i.title ?? i.refLabel} />
                  <div><span className="refid">{i.refLabel}</span> {i.title}</div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Studio({ refId }: { refId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const label = `#${refId.padStart(5, '0')}`;
  const ref = useQuery({ queryKey: ['ref', label], queryFn: () => api.get<{ reference: { refLabel: string; title: string | null; creatorName: string | null; previewUrl: string | null; thumbnailUrl: string | null; status: Status; originalUrl: string } }>(`/api/references/${refId}`) });
  const ctx = useQuery({ queryKey: ['captions', refId], queryFn: () => api.get<Context>(`/api/captions/${refId}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['captions', refId] });
  const status = useStatusChange();
  const [publishing, setPublishing] = useState(false);

  const [gen, setGen] = useState({ length: 'medium', purpose: 'archival_description', tone: 'restrained', factualDensity: 'medium', emphasis: 'context', alternatives: 1 });
  const generate = useMutation({
    mutationFn: (method: 'ai' | 'grounded_template') => api.post<{ drafts: Draft[] }>(`/api/captions/${refId}/generate`, { ...gen, method }),
    onSuccess: (r) => { refresh(); if (r.drafts[0]) setActive(r.drafts[0].id); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const rewrite = useMutation({
    mutationFn: (v: { draftId: string; instruction: string }) => api.post<{ draft: Draft }>(`/api/captions/${refId}/rewrite`, v),
    onSuccess: (r) => { refresh(); setActive(r.draft.id); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const saveDraft = useMutation({
    mutationFn: (v: { body: string; parentDraftId?: string }) => api.post<Draft>(`/api/captions/${refId}/drafts`, v),
    onSuccess: (d) => { refresh(); setActive(d.id); setEditing(null); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });

  const [active, setActive] = useState<string | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ parent?: string; body: string } | null>(null);

  const [finalText, setFinalText] = useState('');
  const [basedOn, setBasedOn] = useState<string | undefined>(undefined);
  const [flags, setFlags] = useState<Flag[] | null>(null);
  useEffect(() => {
    if (ctx.data) {
      setFinalText(ctx.data.finalCaption?.body ?? '');
      setBasedOn(ctx.data.finalCaption?.based_on_draft_id ?? undefined);
    }
  }, [ctx.data?.finalCaption?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!finalText.trim()) return setFlags(null);
    const t = window.setTimeout(() => {
      api.post<{ flags: Flag[] }>(`/api/captions/${refId}/check`, { body: finalText }).then((r) => setFlags(r.flags)).catch(() => setFlags(null));
    }, 500);
    return () => window.clearTimeout(t);
  }, [finalText, refId]);
  const saveFinal = useMutation({
    mutationFn: () => api.put(`/api/captions/${refId}/final`, { body: finalText, basedOnDraftId: basedOn }),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['ref', label] }); toast({ text: 'Final caption saved' }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const [srcForm, setSrcForm] = useState({ url: '', title: '', excerpt: '' });
  const addSource = useMutation({
    mutationFn: () => api.post(`/api/captions/${refId}/sources`, { url: srcForm.url, title: srcForm.title || undefined, excerpt: srcForm.excerpt || undefined }),
    onSuccess: () => { refresh(); setSrcForm({ url: '', title: '', excerpt: '' }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });

  const drafts = ctx.data?.drafts ?? [];
  const activeDraft = drafts.find((d) => d.id === active) ?? drafts[0];
  const compareDraft = drafts.find((d) => d.id === compare);
  const diff = useMemo(() => (activeDraft && compareDraft ? wordDiff(compareDraft.body, activeDraft.body) : null), [activeDraft, compareDraft]);

  if (ctx.isLoading || ref.isLoading) return <Loading />;
  if (ctx.error || !ctx.data) return <ErrorBox error={ctx.error ?? ref.error} retry={() => ctx.refetch()} />;
  const r = ref.data?.reference;
  const ai = ctx.data.ai;
  const savedFinal = ctx.data.finalCaption?.body ?? '';
  const dirty = finalText.trim() !== savedFinal.trim();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(finalText);
      toast({ text: 'Copied to clipboard' });
    } catch {
      toast({ text: 'Copy failed: select the text and copy manually', error: true });
    }
  };
  const exportFile = async () => {
    try {
      const e = await api.get<{ caption: string | null; media: { originalUrl: string; creator: string | null; license: string | null }; researchSources: { url: string; title: string | null }[]; notice: string }>(`/api/captions/${refId}/export`);
      const text = [
        `eccö RADAR ${label}`,
        '',
        e.caption ?? '(no final caption)',
        '',
        `Original: ${e.media.originalUrl}`,
        `Creator (as recorded): ${e.media.creator ?? 'unknown'}`,
        `Rights: ${e.media.license ?? 'not stated by source'}`,
        e.researchSources.length ? `Research sources:\n${e.researchSources.map((s) => `- ${s.title ?? s.url} ${s.url}`).join('\n')}` : '',
        '',
        e.notice,
      ].join('\n');
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `ecco-${label.slice(1)}-caption.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };

  return (
    <div className="studio">
      <aside className="stack lg">
        {r ? (
          <section className="panel">
            <header><Link className="refid" to={`/ref/${refId}`}>{r.refLabel}</Link><StatusBadge status={r.status} /></header>
            <div style={{ background: 'var(--panel-2)' }}><Thumb src={r.previewUrl ?? r.thumbnailUrl} alt={r.title ?? r.refLabel} /></div>
            <div className="body small">
              <b>{r.title ?? 'Untitled'}</b><div>{r.creatorName ?? 'Creator unknown'}</div>
            </div>
          </section>
        ) : null}
        <section className="panel">
          <header><h3>Fact sheet</h3></header>
          <div className="body">
            <p className="small muted">Drafts may only use these facts. Add research notes on the reference page to extend them.</p>
            <dl className="kv small">
              {ctx.data.factSheet.facts.map((f) => (
                <FactRow key={f.key} f={f} />
              ))}
            </dl>
            {ctx.data.factSheet.unknown.length ? <p className="small" style={{ marginTop: 8 }}><b>Unknown:</b> {ctx.data.factSheet.unknown.join(', ')}. Drafts must not fill these in.</p> : null}
          </div>
        </section>
        <section className="panel">
          <header><h3>Research sources</h3></header>
          <div className="body stack">
            {ctx.data.researchSources.length === 0 ? <p className="small muted">None yet.</p> : null}
            {ctx.data.researchSources.map((s) => (
              <div key={s.id} className="small"><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title ?? s.url}</a>{s.excerpt ? <div className="muted">“{s.excerpt.slice(0, 200)}”</div> : null}</div>
            ))}
            <form className="stack" onSubmit={(e) => { e.preventDefault(); addSource.mutate(); }}>
              <input type="url" required placeholder="https://source you consulted" value={srcForm.url} onChange={(e) => setSrcForm({ ...srcForm, url: e.target.value })} aria-label="Source URL" />
              <input placeholder="Title (optional)" value={srcForm.title} onChange={(e) => setSrcForm({ ...srcForm, title: e.target.value })} aria-label="Source title" />
              <textarea rows={2} placeholder="Relevant excerpt (optional)" value={srcForm.excerpt} onChange={(e) => setSrcForm({ ...srcForm, excerpt: e.target.value })} aria-label="Excerpt" />
              <div><button className="sm" type="submit" disabled={!srcForm.url || addSource.isPending}>Add source</button></div>
            </form>
            <p className="small muted">RADAR records sources you add; it does not fetch or summarise them.</p>
          </div>
        </section>
      </aside>

      <div className="stack lg">
        <section className="panel">
          <header><h2>Generate a draft</h2><span className="small muted">{ai.available ? `${ai.provider} · ${ai.model}` : 'AI unavailable'}</span></header>
          <div className="body stack">
            <div className="row">
              <Sel label="Length" value={gen.length} onChange={(v) => setGen({ ...gen, length: v })} opts={['short', 'medium', 'long']} />
              <Sel label="Purpose" value={gen.purpose} onChange={(v) => setGen({ ...gen, purpose: v })} opts={['archival_description', 'cultural_context', 'artist_spotlight', 'period_context', 'technique', 'connection']} />
              <Sel label="Tone" value={gen.tone} onChange={(v) => setGen({ ...gen, tone: v })} opts={['restrained', 'conversational', 'scholarly', 'playful']} />
              <Sel label="Facts" value={gen.factualDensity} onChange={(v) => setGen({ ...gen, factualDensity: v })} opts={['low', 'medium', 'high']} />
              <Sel label="Emphasis" value={gen.emphasis} onChange={(v) => setGen({ ...gen, emphasis: v })} opts={['context', 'artist', 'work', 'period', 'movement', 'technique', 'significance']} />
              <Sel label="Alternatives" value={String(gen.alternatives)} onChange={(v) => setGen({ ...gen, alternatives: Number(v) })} opts={['1', '2', '3']} />
            </div>
            <div className="row">
              <button className="primary" disabled={!ai.available || generate.isPending} onClick={() => generate.mutate('ai')} title={ai.available ? 'Sends only the fact sheet above to the AI provider' : ai.reason}>
                {generate.isPending && generate.variables === 'ai' ? 'Drafting…' : 'Draft with AI'}
              </button>
              <button disabled={generate.isPending} onClick={() => generate.mutate('grounded_template')}>Assemble from facts (no AI)</button>
              <button onClick={() => setEditing({ body: '' })}>Write my own</button>
            </div>
            {!ai.available ? <p className="small muted">{ai.reason}</p> : <p className="small muted">Only the fact sheet above is sent, including your research notes. Analytics imports and account data are never sent.</p>}
          </div>
        </section>

        {editing ? (
          <section className="panel">
            <header><h2>{editing.parent ? 'Edit as new version' : 'New draft'}</h2></header>
            <div className="body stack">
              <textarea rows={6} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label="Draft text" autoFocus />
              <div className="row">
                <button className="primary" disabled={!editing.body.trim() || saveDraft.isPending} onClick={() => saveDraft.mutate({ body: editing.body, parentDraftId: editing.parent })}>Save as new version</button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          </section>
        ) : null}

        <section className="panel">
          <header><h2>Drafts</h2><span className="small muted">{drafts.length} version(s) · drafts are never overwritten</span></header>
          <div className="body stack">
            {drafts.length === 0 ? <Empty title="No drafts yet">Generate, assemble, or write one above.</Empty> : null}
            {drafts.map((d) => (
              <div key={d.id} className={`draft ${activeDraft?.id === d.id ? 'active' : ''}`} onClick={() => setActive(d.id)}>
                <div className="row between">
                  <span className="mono small"><b>v{d.version}</b> · {ORIGIN[d.origin] ?? d.origin}{d.model ? ` · ${d.model}` : ''} · {fmtDateTime(d.created_at)}</span>
                  <span className="row tight">
                    {d.verification_flags.length ? <span className="badge warn">{d.verification_flags.length} to verify</span> : <span className="badge">no flags</span>}
                  </span>
                </div>
                {d.purpose ? <div className="small muted">{[d.length_setting, d.purpose?.replace(/_/g, ' '), d.tone, d.emphasis && `emphasis: ${d.emphasis}`].filter(Boolean).join(' · ')}</div> : null}
                <pre>{d.body}</pre>
                {d.verification_flags.length ? <ul className="flags">{d.verification_flags.map((f, i) => <li key={i}><b>{f.claim}</b>: {f.reason}</li>)}</ul> : null}
                <div className="row tight" style={{ marginTop: 6 }}>
                  <button className="sm" onClick={(e) => { e.stopPropagation(); setFinalText(d.body); setBasedOn(d.id); }}>Use as final text</button>
                  <button className="sm" onClick={(e) => { e.stopPropagation(); setEditing({ parent: d.id, body: d.body }); }}>Edit</button>
                  <select className="sm" aria-label="Rewrite" value="" disabled={!ai.available || rewrite.isPending} onClick={(e) => e.stopPropagation()} onChange={(e) => e.target.value && rewrite.mutate({ draftId: d.id, instruction: e.target.value })} title={ai.available ? 'AI rewrite into a new version' : 'AI unavailable'}>
                    <option value="">Rewrite…</option>
                    <option value="shorter">Shorter</option><option value="longer">Longer</option><option value="more_context">More context</option>
                    <option value="less_context">Less context</option><option value="plainer">Plainer</option><option value="more_precise">More precise</option>
                  </select>
                  {activeDraft && activeDraft.id !== d.id ? (
                    <button className="sm ghost" onClick={(e) => { e.stopPropagation(); setCompare(compare === d.id ? null : d.id); }}>{compare === d.id ? 'Hide compare' : `Compare with v${activeDraft.version}`}</button>
                  ) : null}
                  <button className="sm ghost" onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(d.body).then(() => toast({ text: 'Draft copied' })).catch(() => toast({ text: 'Copy failed', error: true })); }}>Copy</button>
                </div>
              </div>
            ))}
            {diff && compareDraft && activeDraft ? (
              <div className="notice">
                <div className="small mono">v{compareDraft.version} → v{activeDraft.version}</div>
                <p className="diff caption-text">{diff.map((p, i) => (p.kind === 'same' ? <span key={i}>{p.text}</span> : p.kind === 'add' ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>))}</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel">
          <header><h2>Final caption</h2><span className="small muted">{ctx.data.finalCaption ? `saved ${fmtDateTime(ctx.data.finalCaption.updated_at)}` : 'not saved'}</span></header>
          <div className="body stack">
            <textarea rows={7} value={finalText} onChange={(e) => setFinalText(e.target.value)} aria-label="Final caption" placeholder="Your final text. Stored apart from drafts." />
            {flags && flags.length ? <ul className="flags">{flags.map((f, i) => <li key={i}><b>{f.claim}</b>: {f.reason}</li>)}</ul> : flags ? <p className="small muted">No unsupported years, numbers, names or evaluative claims detected. This is a safety net, not proof.</p> : null}
            <div className="row">
              <button className="primary" disabled={!finalText.trim() || !dirty || saveFinal.isPending} onClick={() => saveFinal.mutate()}>Save final caption</button>
              <button disabled={!finalText.trim()} onClick={copy}>Copy</button>
              <button disabled={!savedFinal} onClick={exportFile} title={savedFinal ? 'Download a text file for manual publication' : 'Save a final caption first'}>Export .txt</button>
              <span className="small muted">{finalText.length} characters</span>
            </div>
            {r ? (
              <div className="stack" style={{ borderTop: '1px solid var(--rule)', paddingTop: 8 }}>
                <div className="row">
                  <span className="small">Pipeline:</span>
                  <button className="sm" disabled={r.status === 'caption_draft'} onClick={() => status.mutate({ refLabel: r.refLabel, change: { status: 'caption_draft' }, previous: r.status })}>Mark caption draft</button>
                  <button className="sm" disabled={!savedFinal || r.status === 'reviewed' || dirty} title={!savedFinal || dirty ? 'Save the final caption first' : ''} onClick={() => status.mutate({ refLabel: r.refLabel, change: { status: 'reviewed' }, previous: r.status })}>Mark reviewed</button>
                  <button className="sm" disabled={r.status !== 'reviewed'} title={r.status !== 'reviewed' ? 'Only after Reviewed' : ''} onClick={() => status.mutate({ refLabel: r.refLabel, change: { status: 'approved_publication' }, previous: r.status })}>Approve for manual publication</button>
                  <button className="sm" disabled={r.status !== 'approved_publication'} title={r.status !== 'approved_publication' ? 'Only after Approved for manual publication' : ''} onClick={() => setPublishing(true)}>I published it manually…</button>
                </div>
                <p className="small muted">RADAR has no connection to Instagram, X or any other platform. Approval only marks it ready for you to post by hand.</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>
      {publishing && r ? (
        <PublishedDialog refLabel={r.refLabel} onCancel={() => setPublishing(false)} onConfirm={(c) => { status.mutate({ refLabel: r.refLabel, change: c, previous: r.status }); setPublishing(false); }} />
      ) : null}
    </div>
  );
}

function FactRow({ f }: { f: Fact }) {
  return (
    <>
      <dt title={f.label}>{f.label.replace(/\s*\(.*\)$/, '')}</dt>
      <dd>
        {f.sourceUrl ? <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer">{f.value.length > 300 ? `${f.value.slice(0, 300)}…` : f.value}</a> : f.value.length > 300 ? `${f.value.slice(0, 300)}…` : f.value}
        <span className="badge" style={{ marginLeft: 4 }}>{BASIS[f.basis] ?? f.basis}</span>
      </dd>
    </>
  );
}

function Sel({ label, value, onChange, opts }: { label: string; value: string; onChange: (v: string) => void; opts: string[] }) {
  return (
    <label className="field"><span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>{opts.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select>
    </label>
  );
}
