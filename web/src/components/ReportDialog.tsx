import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Dialog, errorText, useToast } from './ui';

type Kind = 'attribution_incorrect' | 'irrelevant' | 'duplicate_of';
type Scope = 'item' | 'topic' | 'creator' | 'source';

const SCOPES: [Scope, string][] = [
  ['item', 'Only this item'],
  ['topic', 'Its topic / tags (fewer like this)'],
  ['creator', 'This creator'],
  ['source', 'This source'],
];

/**
 * Reports a problem with a reference: wrong attribution, an irrelevant recommendation, or a
 * duplicate of another reference. Each report is kept in the decision history and used as a
 * learning signal; none of them deletes or merges anything.
 */
export function ReportDialog({ refLabel, initial = 'attribution_incorrect', onClose }: { refLabel: string; initial?: Kind; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>(initial);
  const [scope, setScope] = useState<Scope>('item');
  const [otherRef, setOtherRef] = useState('');
  const [notes, setNotes] = useState('');
  const ref = refLabel.replace('#', '');
  const send = useMutation({
    mutationFn: () => {
      const n = notes.trim() || undefined;
      const body = kind === 'irrelevant' ? { kind, scope, notes: n } : kind === 'duplicate_of' ? { kind, otherRef: otherRef.trim(), notes: n } : { kind, notes: n };
      return api.post(`/api/references/${encodeURIComponent(ref)}/report`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['feed'] });
      qc.invalidateQueries({ queryKey: ['ref'] });
      qc.invalidateQueries({ queryKey: ['preferences'] });
      toast({ text: `${refLabel}: report recorded` });
      onClose();
    },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const ready = kind !== 'duplicate_of' || /\d/.test(otherRef);
  return (
    <Dialog
      title={`Report a problem with ${refLabel}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!ready || send.isPending} onClick={() => send.mutate()}>Send report</button>
        </>
      }
    >
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">What is wrong?</legend>
        <div className="stack" style={{ gap: 4, marginTop: 4 }}>
          <label className="check"><input type="radio" name="report-kind" checked={kind === 'attribution_incorrect'} onChange={() => setKind('attribution_incorrect')} />The creator or source attribution is incorrect</label>
          <label className="check"><input type="radio" name="report-kind" checked={kind === 'irrelevant'} onChange={() => setKind('irrelevant')} />This recommendation is irrelevant for eccö</label>
          <label className="check"><input type="radio" name="report-kind" checked={kind === 'duplicate_of'} onChange={() => setKind('duplicate_of')} />It duplicates another reference</label>
        </div>
      </fieldset>
      {kind === 'irrelevant' ? (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted">What does it apply to?</legend>
          <div className="stack" style={{ gap: 4, marginTop: 4 }}>
            {SCOPES.map(([v, l]) => <label key={v} className="check"><input type="radio" name="report-scope" checked={scope === v} onChange={() => setScope(v)} />{l}</label>)}
          </div>
        </fieldset>
      ) : null}
      {kind === 'duplicate_of' ? (
        <label className="field"><span>Reference it duplicates</span><input value={otherRef} onChange={(e) => setOtherRef(e.target.value)} placeholder="#00042" maxLength={20} /></label>
      ) : null}
      <label className="field"><span>Note (optional)</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
      </label>
      <p className="small muted">
        {kind === 'attribution_incorrect' ? 'The attribution is marked disputed and ranked lower until you confirm a correct one. ' : null}
        {kind === 'irrelevant' ? 'Used as a learning signal with the scope you chose. Inspect or reset it in Settings. ' : null}
        {kind === 'duplicate_of' ? 'Both keep their numbers; they are linked as one duplicate group. ' : null}
        The report is kept in the decision history.
      </p>
    </Dialog>
  );
}
