import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime, fmtNum } from '../lib/format';
import { ErrorBox, HBar, Loading, PageHead, errorText, useToast } from '../components/ui';

type Weights = Record<string, number>;
interface Ranking {
  active: { version: number; weights: Weights; diversity: Weights; note: string | null };
  versions: { version: number; note: string | null; is_active: boolean; created_at: string; weights: Weights; diversity: Weights }[];
  components: { key: string; label: string }[];
  defaults: { weights: Weights; diversity: Weights };
}
interface Prefs {
  explanation: string;
  features: { key: string; kind: string; value: string; label: string; weight: number; evidence: number; overridden: boolean }[];
  resets: { id: string; reset_at: string; note: string | null; undone_at: string | null }[];
}
interface Settings {
  settings: Record<'external_ai_enabled' | 'background_paused' | 'visual_analysis_enabled', { value: boolean; description: string }>;
  visual: { analysed: number; failed: number; pending: number; no_preview: number; model: string; hashModel: string };
  ai: { configured: boolean; provider: string | null; model: string | null; usageLast30Days: { provider: string; model: string; purpose: string; calls: number; succeeded: number; input_tokens: number; output_tokens: number }[]; budget: { limit: number | null; usedLast24h: number } };
  publishing: string;
}

const DIVERSITY_LABEL: Record<string, string> = {
  window: 'Look-back window (items)', creator_penalty: 'Same creator', source_penalty: 'Same source', tag_overlap_penalty: 'Overlapping tags',
  near_duplicate_penalty: 'Near-duplicate text', historical_exposure_penalty: 'Already published by eccö',
};

export function SettingsPage() {
  return (
    <>
      <PageHead title="Settings" />
      <div className="content stack lg">
        <General />
        <RankingEditor />
        <Preferences />
      </div>
    </>
  );
}

function AiLimit({ budget }: { budget: { limit: number | null; usedLast24h: number } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(budget.limit === null ? '' : String(budget.limit));
  useEffect(() => setDraft(budget.limit === null ? '' : String(budget.limit)), [budget.limit]);
  const save = useMutation({
    mutationFn: (value: number | null) => api.put('/api/settings/ai_daily_token_limit', { value }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); toast({ text: 'AI limit saved' }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const parsed = draft.trim() === '' ? null : Number(draft);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1000 && parsed <= 100_000_000);
  const reached = budget.limit !== null && budget.usedLast24h >= budget.limit;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(parsed); }}>
      <label className="field">
        <span>Daily AI limit (tokens per 24 hours)</span>
        <div className="row">
          <input inputMode="numeric" value={draft} placeholder="No limit" aria-invalid={!valid} onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))} />
          <button disabled={!valid || save.isPending || parsed === budget.limit}>Save</button>
        </div>
      </label>
      <p className={`small ${reached ? 'warn-text' : 'muted'}`}>
        {budget.limit === null ? `${fmtNum(budget.usedLast24h)} tokens used in the last 24 hours, no limit set.` : `${fmtNum(budget.usedLast24h)} of ${fmtNum(budget.limit)} tokens used in the last 24 hours.`}
        {reached ? ' AI drafts and AI query expansion are paused until usage falls below the limit.' : ''}
        {' '}Applies to caption drafts and background exploration alike. Leave empty for no limit.
      </p>
      {!valid && <p className="small warn-text">Enter a whole number between 1,000 and 100,000,000, or leave it empty.</p>}
    </form>
  );
}

function General() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const set = useMutation({
    mutationFn: ({ key, value }: { key: string; value: boolean }) => api.put(`/api/settings/${key}`, { value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const retry = useMutation({
    mutationFn: () => api.post<{ reset: number }>('/api/visual/reset', { onlyFailed: true }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['settings'] }); toast({ text: `${r.reset} image(s) will be analysed again` }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const s = q.data;
  return (
    <div className="grid2">
      <section className="panel">
        <header><h2>AI provider</h2><span className={`badge ${s.ai.configured ? 'green' : ''}`}>{s.ai.configured ? 'key configured' : 'not configured'}</span></header>
        <div className="body stack">
          <p className="small">{s.ai.configured ? `Provider: ${s.ai.provider} · model ${s.ai.model}.` : 'No ANTHROPIC_API_KEY on the server. Caption Studio can still assemble captions from facts, and you can write your own.'}</p>
          <label className="check">
            <input type="checkbox" disabled={!s.ai.configured} checked={s.settings.external_ai_enabled.value} onChange={(e) => set.mutate({ key: 'external_ai_enabled', value: e.target.checked })} />
            Allow external AI
          </label>
          <p className="small muted">{s.settings.external_ai_enabled.description}</p>
          <AiLimit budget={s.ai.budget} />
          {s.ai.usageLast30Days.length ? (
            <table className="data"><thead><tr><th>Purpose</th><th className="num">Calls</th><th className="num">OK</th><th className="num">Tokens in/out</th></tr></thead>
              <tbody>{s.ai.usageLast30Days.map((u, i) => <tr key={i}><td className="small">{u.purpose.replace(/_/g, ' ')}<div className="muted">{u.model}</div></td><td className="num">{u.calls}</td><td className="num">{u.succeeded}</td><td className="num">{fmtNum(u.input_tokens)} / {fmtNum(u.output_tokens)}</td></tr>)}</tbody>
            </table>
          ) : <p className="small muted">No AI calls in the last 30 days.</p>}
        </div>
      </section>
      <div className="stack lg">
        <section className="panel">
          <header><h2>Background discovery</h2>{s.settings.background_paused.value ? <span className="badge warn">paused</span> : <span className="badge">schedules allowed</span>}</header>
          <div className="body stack">
            <label className="check">
              <input type="checkbox" checked={s.settings.background_paused.value} onChange={(e) => set.mutate({ key: 'background_paused', value: e.target.checked })} />
              Pause all background schedules
            </label>
            <p className="small muted">Nothing runs in the background unless you create and switch on a schedule in Explore.</p>
          </div>
        </section>
        <section className="panel">
          <header><h2>Image analysis</h2><span className="badge">{s.visual.model}</span></header>
          <div className="body stack">
            <label className="check">
              <input type="checkbox" checked={s.settings.visual_analysis_enabled.value} onChange={(e) => set.mutate({ key: 'visual_analysis_enabled', value: e.target.checked })} />
              Analyse preview images
            </label>
            <p className="small muted">{s.settings.visual_analysis_enabled.description} It measures colour, tone and layout structure only; it does not recognise subjects or style.</p>
            <p className="small">{s.visual.analysed} analysed · {s.visual.pending} waiting · {s.visual.failed} failed · {s.visual.no_preview} without a preview</p>
            {s.visual.failed ? <div><button className="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry failed images</button></div> : null}
          </div>
        </section>
        <section className="panel">
          <header><h2>Publishing</h2><span className="badge solid">none</span></header>
          <div className="body"><p className="small">{s.publishing} There is no code path that posts, schedules or transmits to a social platform; the server has no such integration to switch on.</p></div>
        </section>
      </div>
    </div>
  );
}

function RankingEditor() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ranking'], queryFn: () => api.get<Ranking>('/api/ranking') });
  const [weights, setWeights] = useState<Weights | null>(null);
  const [diversity, setDiversity] = useState<Weights | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (q.data) {
      setWeights(q.data.active.weights);
      setDiversity(q.data.active.diversity);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.post<{ version: number }>('/api/ranking', { weights, diversity, note: note || undefined }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['ranking'] }); qc.invalidateQueries({ queryKey: ['feed'] }); setNote(''); toast({ text: `Ranking v${r.version} is now active` }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const activate = useMutation({
    mutationFn: (v: number) => api.post(`/api/ranking/${v}/activate`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ranking'] }); qc.invalidateQueries({ queryKey: ['feed'] }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  if (q.isLoading || !weights || !diversity) return q.error ? <ErrorBox error={q.error} /> : <Loading />;
  const d = q.data!;
  const changed = JSON.stringify(weights) !== JSON.stringify(d.active.weights) || JSON.stringify(diversity) !== JSON.stringify(d.active.diversity);
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  return (
    <section className="panel">
      <header><h2>Ranking · active v{d.active.version}</h2><span className="small muted">Every change creates a new version; older versions can be reactivated.</span></header>
      <div className="body grid2">
        <div className="stack">
          <h3>Component weights</h3>
          <table className="data">
            <tbody>
              {d.components.map((c) => {
                const max = c.key === 'audience_resonance' ? 1.5 : 5;
                return (
                  <tr key={c.key}>
                    <td>{c.label}{c.key === 'audience_resonance' ? <div className="small muted">Capped at 1.5 so engagement never outweighs editorial judgement.</div> : null}{c.key === 'visual_affinity' ? <div className="small muted">Colour and tone only. Empty until at least 3 approved references have analysed images.</div> : null}</td>
                    <td style={{ width: 160 }}><input type="range" min={0} max={max} step={0.1} value={weights[c.key] ?? 0} onChange={(e) => setWeights({ ...weights, [c.key]: Number(e.target.value) })} aria-label={c.label} style={{ width: '100%' }} /></td>
                    <td className="num" style={{ width: 50 }}>{(weights[c.key] ?? 0).toFixed(1)}</td>
                    <td style={{ width: 80 }}><HBar value={(weights[c.key] ?? 0) / total} max={0.5} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="stack">
          <h3>Diversity re-ranking</h3>
          <table className="data">
            <tbody>
              {Object.keys(DIVERSITY_LABEL).map((k) => (
                <tr key={k}>
                  <td>{DIVERSITY_LABEL[k]}</td>
                  <td style={{ width: 160 }}>
                    {k === 'window'
                      ? <input type="number" min={2} max={60} value={diversity[k] ?? 12} onChange={(e) => setDiversity({ ...diversity, [k]: Math.max(2, Math.min(60, Math.round(Number(e.target.value)))) })} aria-label={DIVERSITY_LABEL[k]} style={{ width: 70 }} />
                      : <input type="range" min={0} max={1} step={0.01} value={diversity[k] ?? 0} onChange={(e) => setDiversity({ ...diversity, [k]: Number(e.target.value) })} aria-label={DIVERSITY_LABEL[k]} style={{ width: '100%' }} />}
                  </td>
                  <td className="num" style={{ width: 50 }}>{k === 'window' ? diversity[k] : (diversity[k] ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="field"><span>Note for this version</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. more weight on novelty" maxLength={500} /></label>
          <div className="row">
            <button className="primary" disabled={!changed || save.isPending} onClick={() => save.mutate()}>Save as new version</button>
            <button disabled={!changed} onClick={() => { setWeights(d.active.weights); setDiversity(d.active.diversity); }}>Discard changes</button>
            <button onClick={() => { setWeights(d.defaults.weights); setDiversity(d.defaults.diversity); }}>Load defaults</button>
          </div>
          <h3 style={{ marginTop: 8 }}>Versions</h3>
          <table className="data">
            <tbody>
              {d.versions.map((v) => (
                <tr key={v.version}>
                  <td className="mono">v{v.version}</td>
                  <td className="small">{v.note ?? '—'}<div className="muted">{fmtDateTime(v.created_at)}</div></td>
                  <td className="right">{v.is_active ? <span className="badge green">active</span> : <button className="sm" onClick={() => activate.mutate(v.version)}>Activate</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Preferences() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['preferences'], queryFn: () => api.get<Prefs>('/api/preferences') });
  const done = () => { qc.invalidateQueries({ queryKey: ['preferences'] }); qc.invalidateQueries({ queryKey: ['feed'] }); };
  const onErr = (e: unknown) => toast({ text: errorText(e), error: true });
  const reset = useMutation({ mutationFn: (note: string) => api.post('/api/preferences/reset', { note: note || undefined }), onSuccess: done, onError: onErr });
  const undo = useMutation({ mutationFn: (id: string) => api.post(`/api/preferences/reset/${id}/undo`), onSuccess: done, onError: onErr });
  const override = useMutation({ mutationFn: (b: { kind: string; value: string; weight: number }) => api.put('/api/preferences/overrides', b), onSuccess: done, onError: onErr });
  const clear = useMutation({ mutationFn: (b: { kind: string; value: string }) => api.del('/api/preferences/overrides', b), onSuccess: done, onError: onErr });
  const [form, setForm] = useState({ kind: 'tag', value: '', weight: 0.5 });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  const activeReset = d.resets.find((r) => !r.undone_at);
  return (
    <section className="panel">
      <header><h2>Learned preferences</h2>
        <button className="sm" onClick={() => { const note = window.prompt('Reset learning from now on. Earlier decisions stay in history. Optional note:'); if (note !== null) reset.mutate(note); }}>Reset learning…</button>
      </header>
      <div className="body stack">
        <p className="small muted">{d.explanation}</p>
        {activeReset ? (
          <div className="notice small row between">
            <span>Learning restarted {fmtDateTime(activeReset.reset_at)}{activeReset.note ? ` (“${activeReset.note}”)` : ''}. Decisions before then are ignored.</span>
            <button className="sm" onClick={() => undo.mutate(activeReset.id)}>Undo reset</button>
          </div>
        ) : null}
        {d.features.length === 0 ? <p className="small muted">Nothing learned yet. Approve and reject references to teach RADAR.</p> : (
          <div className="scroll-x" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="data">
              <thead><tr><th>Kind</th><th>Feature</th><th className="num">Weight</th><th className="num">Decisions</th><th /></tr></thead>
              <tbody>
                {d.features.slice(0, 200).map((f) => (
                  <tr key={f.key}>
                    <td className="small">{f.kind}</td>
                    <td>{f.label}{f.overridden ? <span className="badge" style={{ marginLeft: 4 }}>override</span> : null}</td>
                    <td className="num" style={{ color: f.weight < 0 ? 'var(--danger)' : 'var(--green-ink)' }}>{f.weight > 0 ? '+' : ''}{f.weight.toFixed(2)}</td>
                    <td className="num">{f.evidence}</td>
                    <td className="right nowrap">
                      {f.overridden
                        ? <button className="sm ghost" onClick={() => clear.mutate({ kind: f.kind, value: f.value })}>Clear override</button>
                        : <>
                            <button className="sm ghost" title="Always favour" onClick={() => override.mutate({ kind: f.kind, value: f.value, weight: 1 })}>+</button>
                            <button className="sm ghost" title="Ignore" onClick={() => override.mutate({ kind: f.kind, value: f.value, weight: 0 })}>0</button>
                            <button className="sm ghost" title="Always disfavour" onClick={() => override.mutate({ kind: f.kind, value: f.value, weight: -1 })}>−</button>
                          </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (form.value.trim()) override.mutate({ ...form, value: form.value.trim() }); setForm({ ...form, value: '' }); }}>
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Feature kind">
            {['tag', 'creator', 'source', 'media_type'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
          </select>
          <input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="value" aria-label="Feature value" />
          <input type="number" min={-1} max={1} step={0.1} value={form.weight} onChange={(e) => setForm({ ...form, weight: Math.max(-1, Math.min(1, Number(e.target.value))) })} aria-label="Weight" style={{ width: 70 }} />
          <button className="sm" type="submit" disabled={!form.value.trim()}>Set override</button>
        </form>
      </div>
    </section>
  );
}
