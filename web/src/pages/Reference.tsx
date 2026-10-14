import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { STATUS_LABEL, type Status } from '../lib/types';
import { fmtDateTime, hostOf } from '../lib/format';
import { Dialog, Empty, ErrorBox, HBar, Loading, PageHead, StatusBadge, Thumb, errorText, useToast } from '../components/ui';
import { PublishedDialog, RejectDialog, useStatusChange } from '../components/StatusActions';

interface Mini { id: string; refLabel: string; title: string | null; creatorName: string | null; thumbnailUrl: string | null; previewUrl: string | null; status: Status; score: number }
interface Detail {
  reference: {
    id: string; refNumber: number; refLabel: string; originalUrl: string; canonicalUrl: string; sourceId: string; sourceName: string; sourceItemId: string | null;
    creatorName: string | null; creatorUrl: string | null; title: string | null; description: string | null; publishedRaw: string | null; publishedDate: string | null;
    publishedPrecision: string; discoveredAt: string; previewUrl: string | null; thumbnailUrl: string | null; mediaType: string; width: number | null; height: number | null;
    durationSeconds: number | null; license: string | null; rightsStatement: string | null; verificationStatus: string; attributionStatus: string; status: Status;
    statusMeta: { label: string; meaning: string }; deletedAt: string | null; embeddingModel: string | null; visualAnalysis: string;
  };
  tags: { tag: string; origin: string; state: string; confidence: number | null }[];
  entities: { entity_id: string; label: string; kind: string; wikidata_id: string | null; external_url: string | null; predicate: string; evidence: string; confidence: number | null; provenance: string; provenance_url: string | null }[];
  duplicates: { kind: string; method: string; score: number | null; evidence: string; other: Mini | null }[];
  related: { semantic: Mini[]; visual: Mini[] | null; sameCreator: Mini[]; sharedEntities: Mini[] };
  discoveries: { id: string; method: string; query_text: string | null; path: { kind: string; label: string; detail?: string }[]; rank_in_results: number | null; discovered_at: string; is_first: boolean; source_id: string; session_id: string | null; session_query: string | null; session_mode: string | null }[];
  decisions: { id: string; decision_type: string; reason_code: string | null; reason_scope: string | null; notes: string | null; previous_status: string | null; new_status: string | null; payload: Record<string, unknown> | null; created_at: string; actor: string | null }[];
  notes: { id: string; body: string; created_at: string; updated_at: string; author: string | null }[];
  researchSources: { id: string; url: string; title: string | null; publisher: string | null }[];
  captionDrafts: { id: string; version: number; origin: string; created_at: string; preview: string }[];
  finalCaption: { body: string; updated_at: string } | null;
  publicationReports: { platform: string | null; permalink: string | null; published_on: string | null; verification: string; created_at: string }[];
  score: {
    total: number; rankingVersion: number; mode: string; reasons: string[]; caveats: string[];
    components: { key: string; label: string; value: number | null; weight: number; note: string }[];
    penalties: { key: string; label: string; amount: number }[];
  };
}

const ATTRIBUTION_LABEL: Record<string, string> = {
  source_provided: 'As stated by the source (not independently verified)',
  editor_confirmed: 'Confirmed by editor',
  reported_incorrect: 'Reported incorrect by editor',
  unknown: 'Unknown',
};

function Panel({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="panel">
      <header><h3>{title}</h3>{right}</header>
      <div className="body">{children}</div>
    </section>
  );
}

export function ReferencePage() {
  const { ref = '' } = useParams();
  const label = `#${ref.replace('#', '').padStart(5, '0')}`;
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['ref', label], queryFn: () => api.get<Detail>(`/api/references/${encodeURIComponent(ref)}`) });
  const status = useStatusChange();
  const [dialog, setDialog] = useState<null | 'reject' | 'published' | 'delete'>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['ref', label] });
  const call = useMutation({
    mutationFn: ({ path, body, method = 'post' }: { path: string; body?: unknown; method?: 'post' | 'patch' }) => api[method](`/api/references/${ref}/${path}`, body),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['feed'] }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const explore = useMutation({
    mutationFn: async () => {
      const opts = await api.get<{ sources: { id: string; ready: boolean }[] }>('/api/exploration/options');
      return api.post<{ id: string }>('/api/explorations/from-reference', { ref, mode: 'adjacent', sourceIds: opts.sources.filter((s) => s.ready).map((s) => s.id).slice(0, 10) });
    },
    onSuccess: (r) => nav(`/explore/${r.id}`),
    onError: (e) => toast({ text: errorText(e), error: true }),
  });

  if (q.isLoading) return <><PageHead title={label} /><div className="content"><Loading /></div></>;
  if (q.error || !q.data) return <><PageHead title={label} /><div className="content"><ErrorBox error={q.error} retry={() => q.refetch()} /></div></>;
  const d = q.data;
  const r = d.reference;
  const setStatus = (to: Status) => {
    if (to === 'rejected') return setDialog('reject');
    if (to === 'manually_published') return setDialog('published');
    status.mutate({ refLabel: r.refLabel, change: { status: to }, previous: r.status });
  };

  const documented = d.entities.filter((e) => e.evidence === 'documented' || e.evidence === 'editor_confirmed');
  const inferred = d.entities.filter((e) => e.evidence === 'inferred');
  const rejectedRel = d.entities.filter((e) => e.evidence === 'editor_rejected');

  return (
    <>
      <PageHead title={r.refLabel} sub={r.title ?? 'Untitled'}>
        <StatusBadge status={r.status} long />
        <select aria-label="Change status" value="" onChange={(e) => e.target.value && setStatus(e.target.value as Status)}>
          <option value="">Change status…</option>
          {(Object.keys(STATUS_LABEL) as Status[]).filter((s) => s !== r.status).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <Link className="btn" to={`/studio/${r.refNumber}`}>Caption Studio</Link>
        <button onClick={() => explore.mutate()} disabled={explore.isPending} title="Start an exploration from this reference’s creator, title and tags">{explore.isPending ? 'Starting…' : 'Explore from here'}</button>
        <a className="btn" href={r.originalUrl} target="_blank" rel="noopener noreferrer">Original ↗</a>
      </PageHead>
      <div className="content">
        {r.deletedAt ? (
          <div className="notice warn row between" style={{ marginBottom: 12 }}>
            <span>Deleted on {fmtDateTime(r.deletedAt)}. Its ID {r.refLabel} stays reserved.</span>
            <button className="sm" onClick={() => call.mutate({ path: 'restore' })}>Restore</button>
          </div>
        ) : null}
        <p className="small muted" style={{ marginBottom: 12 }}>{r.statusMeta.meaning}</p>
        <div className="detail">
          <div>
            <div className="viewer">
              {r.mediaType === 'image' || r.previewUrl ? (
                <Thumb src={r.previewUrl ?? r.thumbnailUrl} alt={r.title ?? r.refLabel} />
              ) : (
                <div className="noimg" style={{ aspectRatio: '4/3', display: 'flex' }}>No preview</div>
              )}
            </div>
            <p className="small muted" style={{ marginTop: 6 }}>
              Image shown directly from {hostOf(r.previewUrl ?? r.originalUrl)}. Visual analysis: {r.visualAnalysis}.
            </p>
          </div>

          <div className="stack lg">
            <Panel title="Source-stated metadata" right={<span className={`badge ${r.verificationStatus === 'disputed' ? 'danger' : r.verificationStatus === 'editor_verified' ? 'green' : ''}`}>{({ source_metadata: 'not independently verified', editor_verified: 'verified by editor', disputed: 'disputed', unverified: 'unverified' } as Record<string, string>)[r.verificationStatus] ?? r.verificationStatus}</span>}>
              <dl className="kv">
                <dt>Title</dt><dd>{r.title ?? <span className="muted">Not given</span>}</dd>
                <dt>Creator</dt>
                <dd>
                  {r.creatorName ? (r.creatorUrl ? <a href={r.creatorUrl} target="_blank" rel="noopener noreferrer">{r.creatorName}</a> : r.creatorName) : <span className="muted">Unknown</span>}
                  <div className="small muted">{ATTRIBUTION_LABEL[r.attributionStatus] ?? r.attributionStatus}</div>
                </dd>
                <dt>Date</dt><dd>{r.publishedRaw ?? <span className="muted">Unknown</span>} {r.publishedRaw ? <span className="small muted">(precision: {r.publishedPrecision})</span> : null}</dd>
                <dt>Source</dt><dd>{r.sourceName} · <a href={r.originalUrl} target="_blank" rel="noopener noreferrer">{hostOf(r.originalUrl)}</a></dd>
                <dt>Media</dt><dd>{r.mediaType}{r.width && r.height ? ` · ${r.width}×${r.height}` : ''}{r.durationSeconds ? ` · ${r.durationSeconds}s` : ''}</dd>
                <dt>Rights</dt><dd>{r.license ?? r.rightsStatement ?? <span className="muted">Not stated by source</span>}</dd>
                <dt>Discovered</dt><dd>{fmtDateTime(r.discoveredAt)}</dd>
                {r.description ? (<><dt>Description</dt><dd className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{r.description}</dd></>) : null}
              </dl>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="sm" disabled={r.attributionStatus === 'editor_confirmed' || !r.creatorName} onClick={() => call.mutate({ path: 'report', body: { kind: 'attribution_confirmed' } })}>Confirm attribution</button>
                <button className="sm" disabled={r.attributionStatus === 'reported_incorrect'} onClick={() => {
                  const notes = window.prompt('What is wrong with the attribution? (optional)') ?? undefined;
                  call.mutate({ path: 'report', body: { kind: 'attribution_incorrect', notes: notes || undefined } });
                }}>Report incorrect attribution</button>
                <button className="sm" onClick={() => call.mutate({ path: 'report', body: { kind: 'irrelevant', scope: 'item' } })}>Mark irrelevant</button>
              </div>
            </Panel>

            <Panel title={`Score ${d.score.total.toFixed(2)} · ranking v${d.score.rankingVersion} · ${d.score.mode} mode`}>
              <table className="data scoretable">
                <thead><tr><th>Component</th><th className="num">Value</th><th className="num">Weight</th><th /></tr></thead>
                <tbody>
                  {d.score.components.map((c) => (
                    <tr key={c.key} title={c.note}>
                      <td>{c.label}<div className="small muted">{c.note}</div></td>
                      <td className="num">{c.value === null ? '—' : c.value.toFixed(2)}</td>
                      <td className="num">{c.weight}</td>
                      <td className="bar">{c.value === null ? <span className="small muted">not available</span> : <HBar value={c.value} green />}</td>
                    </tr>
                  ))}
                  {d.score.penalties.map((p) => (
                    <tr key={p.key}><td>Penalty: {p.label}</td><td className="num">−{p.amount.toFixed(2)}</td><td /><td /></tr>
                  ))}
                </tbody>
              </table>
              {d.score.reasons.length ? <p className="small" style={{ marginTop: 8 }}><b>Why:</b> {d.score.reasons.join(' · ')}</p> : null}
              {d.score.caveats.length ? <p className="small"><b>Caveats:</b> {d.score.caveats.join(' · ')}</p> : null}
            </Panel>

            <TagsPanel d={d} onEdit={(tag, action) => call.mutate({ path: 'tags', body: { tag, action } })} />

            <Panel title="Cultural connections">
              <h3 style={{ marginBottom: 4 }}>Documented</h3>
              {documented.length ? <EntityList list={documented} onDecide={(e, verdict) => call.mutate({ path: 'relationships', body: { entityId: e.entity_id, predicate: e.predicate, verdict } })} /> : <p className="small muted">No documented connections. They come from source metadata or Wikidata statements.</p>}
              <h3 style={{ margin: '10px 0 4px' }}>Inferred (not verified)</h3>
              {inferred.length ? <EntityList list={inferred} onDecide={(e, verdict) => call.mutate({ path: 'relationships', body: { entityId: e.entity_id, predicate: e.predicate, verdict } })} /> : <p className="small muted">None.</p>}
              {rejectedRel.length ? <p className="small muted" style={{ marginTop: 8 }}>Rejected by you: {rejectedRel.map((e) => e.label).join(', ')}</p> : null}
            </Panel>

            <Panel title="How it was found">
              {d.discoveries.length === 0 ? <p className="small muted">No discovery record.</p> : (
                <ul className="timeline">
                  {d.discoveries.map((x) => (
                    <li key={x.id}>
                      <div className="small muted">{fmtDateTime(x.discovered_at)} · {x.method.replace(/_/g, ' ')}{x.is_first ? ' · first discovery' : ' · rediscovered'}{x.rank_in_results ? ` · result #${x.rank_in_results}` : ''}</div>
                      <div className="provpath">
                        {x.path.map((p, i) => (
                          <span key={i} className="row tight">
                            {i > 0 ? <span className="sep">→</span> : null}
                            <span className="step" title={p.detail}>{p.kind}: {p.label}</span>
                          </span>
                        ))}
                      </div>
                      {x.session_id ? <Link className="small" to={`/explore/${x.session_id}`}>Session “{x.session_query}” ({x.session_mode})</Link> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <DuplicatesPanel d={d} onReport={(body) => call.mutate({ path: 'report', body })} />

            <Panel title="Related references">
              <RelatedGroup title="Semantically similar (text)" list={d.related.semantic} note={r.embeddingModel ? `Model: ${r.embeddingModel}, local lexical similarity of titles, descriptions and tags.` : 'No text embedding.'} />
              <RelatedGroup title="Visually similar" list={d.related.visual ?? []} note={d.related.visual === null ? 'Not available: this image has not been visually analysed. Visual and text similarity are never mixed.' : 'Perceptual-hash similarity.'} />
              <RelatedGroup title="Same creator" list={d.related.sameCreator} />
              <RelatedGroup title="Shared cultural entities" list={d.related.sharedEntities} />
            </Panel>

            <NotesPanel d={d} onAdd={(body) => call.mutate({ path: 'notes', body: { body } })} onUpdate={(id, body) => call.mutate({ path: `notes/${id}`, body: { body }, method: 'patch' })} />

            <Panel title="Captions">
              {d.finalCaption ? <div className="caption-text">{d.finalCaption.body}</div> : <p className="small muted">No final caption.</p>}
              <p className="small muted">{d.captionDrafts.length} draft version(s).</p>
              <Link className="btn" to={`/studio/${r.refNumber}`}>Open in Caption Studio</Link>
              {d.publicationReports.length ? (
                <div style={{ marginTop: 10 }}>
                  <h3>Publication reports (entered by editor)</h3>
                  {d.publicationReports.map((p, i) => (
                    <div key={i} className="small">{p.platform ?? 'unspecified'} · {p.published_on ?? 'date not given'} {p.permalink ? <a href={p.permalink} target="_blank" rel="noopener noreferrer">link</a> : null} · <span className="muted">{p.verification.replace('_', ' ')}</span></div>
                  ))}
                </div>
              ) : null}
            </Panel>

            <Panel title="History">
              {d.decisions.length === 0 ? <p className="small muted">No decisions yet.</p> : (
                <ul className="timeline">
                  {d.decisions.map((x) => (
                    <li key={x.id}>
                      <div className="small muted">{fmtDateTime(x.created_at)}{x.actor ? ` · ${x.actor}` : ''}</div>
                      <div>
                        {x.decision_type === 'status_change'
                          ? <>{x.previous_status ? STATUS_LABEL[x.previous_status as Status] : '—'} → <b>{STATUS_LABEL[x.new_status as Status] ?? x.new_status}</b></>
                          : x.decision_type.replace(/_/g, ' ')}
                        {x.reason_code ? <span className="small"> · {x.reason_code.replace(/_/g, ' ')}{x.reason_scope ? ` (${x.reason_scope})` : ''}</span> : null}
                      </div>
                      {x.notes ? <div className="small">{x.notes}</div> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {!r.deletedAt ? (
              <div className="row"><button className="danger sm" onClick={() => setDialog('delete')}>Delete reference…</button></div>
            ) : null}
          </div>
        </div>
      </div>

      {dialog === 'reject' ? (
        <RejectDialog refLabel={r.refLabel} onCancel={() => setDialog(null)} onConfirm={(c) => { status.mutate({ refLabel: r.refLabel, change: c, previous: r.status }); setDialog(null); }} />
      ) : null}
      {dialog === 'published' ? (
        <PublishedDialog refLabel={r.refLabel} onCancel={() => setDialog(null)} onConfirm={(c) => { status.mutate({ refLabel: r.refLabel, change: c, previous: r.status }); setDialog(null); }} />
      ) : null}
      {dialog === 'delete' ? (
        <DeleteDialog refLabel={r.refLabel} onCancel={() => setDialog(null)} onConfirm={(reason) => { call.mutate({ path: 'delete', body: { confirm: true, reason: reason || undefined } }); setDialog(null); }} />
      ) : null}
    </>
  );
}

function EntityList({ list, onDecide }: { list: Detail['entities']; onDecide: (e: Detail['entities'][number], v: 'confirm' | 'reject') => void }) {
  return (
    <table className="data">
      <tbody>
        {list.map((e) => (
          <tr key={`${e.entity_id}-${e.predicate}`}>
            <td>
              {e.external_url ? <a href={e.external_url} target="_blank" rel="noopener noreferrer">{e.label}</a> : e.label}
              <span className="small muted"> · {e.kind}</span>
            </td>
            <td className="small">{e.predicate.replace(/_/g, ' ')}</td>
            <td className="small muted">
              {e.provenance_url ? <a href={e.provenance_url} target="_blank" rel="noopener noreferrer">{e.provenance}</a> : e.provenance}
              {e.evidence === 'editor_confirmed' ? <span className="badge green" style={{ marginLeft: 4 }}>confirmed</span> : null}
            </td>
            <td className="right nowrap">
              {e.evidence !== 'editor_confirmed' ? <button className="sm" onClick={() => onDecide(e, 'confirm')}>Confirm</button> : null}
              <button className="sm ghost" onClick={() => onDecide(e, 'reject')}>Reject</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TagsPanel({ d, onEdit }: { d: Detail; onEdit: (tag: string, action: 'add' | 'confirm' | 'reject') => void }) {
  const [tag, setTag] = useState('');
  const byTag = new Map<string, Detail['tags']>();
  for (const t of d.tags) byTag.set(t.tag, [...(byTag.get(t.tag) ?? []), t]);
  return (
    <Panel title="Tags">
      <div>
        {[...byTag.entries()].map(([name, list]) => {
          const state = list.some((t) => t.state === 'confirmed') ? 'confirmed' : list.every((t) => t.state === 'rejected') ? 'rejected' : 'suggested';
          const origins = [...new Set(list.map((t) => t.origin))].join(', ');
          return (
            <span key={name} className={`tagchip ${state}`} title={`origin: ${origins} · ${state}`}>
              <Link to={`/?tag=${encodeURIComponent(name)}`} style={{ textDecoration: 'none' }}>{name}</Link>
              {state !== 'confirmed' ? <button aria-label={`Confirm tag ${name}`} onClick={() => onEdit(name, 'confirm')}>✓</button> : null}
              {state !== 'rejected' ? <button aria-label={`Reject tag ${name}`} onClick={() => onEdit(name, 'reject')}>✕</button> : null}
            </span>
          );
        })}
        {d.tags.length === 0 ? <p className="small muted">No tags.</p> : null}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) { onEdit(tag.trim(), 'add'); setTag(''); } }} style={{ marginTop: 6 }}>
        <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add tag" maxLength={120} aria-label="New tag" />
        <button className="sm" type="submit" disabled={!tag.trim()}>Add</button>
      </form>
      <p className="small muted" style={{ marginTop: 6 }}>Source tags come from the source; suggested tags are inferred and are not facts until you confirm them.</p>
    </Panel>
  );
}

function DuplicatesPanel({ d, onReport }: { d: Detail; onReport: (b: unknown) => void }) {
  if (!d.duplicates.length) return null;
  return (
    <Panel title="Possible duplicates">
      <table className="data">
        <tbody>
          {d.duplicates.map((x, i) => (
            <tr key={i}>
              <td>{x.other ? <Link className="refid" to={`/ref/${x.other.refLabel.slice(1)}`}>{x.other.refLabel}</Link> : '—'} <span className="small">{x.other?.title}</span></td>
              <td className="small">{x.method.replace(/_/g, ' ')}{x.score !== null ? ` · ${x.score.toFixed(2)}` : ''}</td>
              <td className="small">{x.kind === 'duplicate_candidate' ? 'candidate' : x.kind === 'confirmed_duplicate' ? <b>confirmed</b> : 'not a duplicate'}</td>
              <td className="right nowrap">
                {x.kind === 'duplicate_candidate' && x.other ? (
                  <>
                    <button className="sm" onClick={() => onReport({ kind: 'duplicate_of', otherId: x.other!.id })}>Same item</button>
                    <button className="sm ghost" onClick={() => onReport({ kind: 'not_duplicate_of', otherId: x.other!.id })}>Different</button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Nothing is merged automatically. Confirming keeps both IDs and links them.</p>
    </Panel>
  );
}

function RelatedGroup({ title, list, note }: { title: string; list: Mini[]; note?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h3 style={{ marginBottom: 4 }}>{title}</h3>
      {note ? <p className="small muted">{note}</p> : null}
      {list.length ? (
        <div className="minirefs">
          {list.map((m) => (
            <Link key={m.id} className="miniref" to={`/ref/${m.refLabel.slice(1)}`} title={`${m.refLabel} ${m.title ?? ''}`}>
              <Thumb src={m.thumbnailUrl ?? m.previewUrl} alt={m.title ?? m.refLabel} />
              <div className="refid">{m.refLabel}</div>
            </Link>
          ))}
        </div>
      ) : <p className="small muted">None found.</p>}
    </div>
  );
}

function NotesPanel({ d, onAdd, onUpdate }: { d: Detail; onAdd: (b: string) => void; onUpdate: (id: string, b: string) => void }) {
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  return (
    <Panel title="Research notes">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (body.trim()) { onAdd(body.trim()); setBody(''); } }}>
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What you found, where, and how sure you are. Notes can be used as facts in Caption Studio." aria-label="New note" />
        <div><button className="sm" type="submit" disabled={!body.trim()}>Add note</button></div>
      </form>
      {d.notes.length === 0 ? <Empty title="No notes yet" /> : null}
      {d.notes.map((n) => (
        <div key={n.id} style={{ borderTop: '1px solid var(--rule)', paddingTop: 6, marginTop: 6 }}>
          <div className="small muted">{n.author ?? 'Editor'} · {fmtDateTime(n.created_at)}{n.updated_at !== n.created_at ? ` · edited ${fmtDateTime(n.updated_at)}` : ''}</div>
          {editing === n.id ? (
            <div className="stack">
              <textarea rows={3} value={editBody} onChange={(e) => setEditBody(e.target.value)} aria-label="Edit note" />
              <div className="row"><button className="sm primary" onClick={() => { onUpdate(n.id, editBody); setEditing(null); }}>Save</button><button className="sm" onClick={() => setEditing(null)}>Cancel</button></div>
            </div>
          ) : (
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              <button className="sm ghost" onClick={() => { setEditing(n.id); setEditBody(n.body); }}>Edit</button>
            </div>
          )}
        </div>
      ))}
    </Panel>
  );
}

function DeleteDialog({ refLabel, onCancel, onConfirm }: { refLabel: string; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  return (
    <Dialog title={`Delete ${refLabel}`} onClose={onCancel} footer={<><button onClick={onCancel}>Cancel</button><button className="danger" disabled={typed !== refLabel} onClick={() => onConfirm(reason)}>Delete</button></>}>
      <p>The reference is hidden from RADAR but kept for audit and can be restored. Its ID is never reused. To record that it does not fit eccö, <b>reject</b> it instead.</p>
      <label className="field"><span>Reason (optional)</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <label className="field"><span>Type {refLabel} to confirm</span><input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
    </Dialog>
  );
}
