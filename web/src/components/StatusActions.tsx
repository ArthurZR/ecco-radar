import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { REJECTION_REASONS, STATUS_LABEL, type Status } from '../lib/types';
import { Dialog, useToast, errorText } from './ui';

export interface StatusChange {
  status: Status;
  reasonCode?: string;
  reasonScope?: 'item' | 'topic' | 'creator' | 'source';
  notes?: string;
  publication?: { platform?: string; permalink?: string; publishedOn?: string };
}

/** Status change with undo: the previous status is restored through the same audited endpoint. */
export function useStatusChange() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ refLabel, change }: { refLabel: string; change: StatusChange; previous?: Status; silent?: boolean }) =>
      api.post(`/api/references/${encodeURIComponent(refLabel.replace('#', ''))}/status`, change),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['feed'] });
      qc.invalidateQueries({ queryKey: ['ref', v.refLabel] });
      qc.invalidateQueries({ queryKey: ['archive'] });
      qc.invalidateQueries({ queryKey: ['facets'] });
      if (v.silent) return;
      const prev = v.previous;
      toast({
        text: `${v.refLabel} → ${STATUS_LABEL[v.change.status]}`,
        action: prev && prev !== v.change.status
          ? {
              label: 'Undo',
              run: () =>
                api
                  .post(`/api/references/${v.refLabel.replace('#', '')}/status`, { status: prev, notes: 'Undo' })
                  .then(() => {
                    qc.invalidateQueries({ queryKey: ['feed'] });
                    qc.invalidateQueries({ queryKey: ['ref', v.refLabel] });
                  })
                  .catch((e) => toast({ text: errorText(e), error: true })),
            }
          : undefined,
      });
    },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
}

export function RejectDialog({ refLabel, onCancel, onConfirm }: { refLabel: string; onCancel: () => void; onConfirm: (c: StatusChange) => void }) {
  const [reasonCode, setReason] = useState('off_identity');
  const [reasonScope, setScope] = useState<'item' | 'topic' | 'creator' | 'source'>('item');
  const [notes, setNotes] = useState('');
  return (
    <Dialog
      title={`Reject ${refLabel}`}
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onConfirm({ status: 'rejected', reasonCode, reasonScope, notes: notes || undefined })}>Reject</button>
        </>
      }
    >
      <label className="field"><span>Reason</span>
        <select value={reasonCode} onChange={(e) => setReason(e.target.value)}>
          {REJECTION_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">What does this rejection apply to?</legend>
        <div className="stack" style={{ gap: 4, marginTop: 4 }}>
          {([
            ['item', 'Only this item (weak learning signal)'],
            ['topic', 'Its topic / tags'],
            ['creator', 'This creator'],
            ['source', 'This source'],
          ] as const).map(([v, l]) => (
            <label key={v} className="check"><input type="radio" name="scope" checked={reasonScope === v} onChange={() => setScope(v)} />{l}</label>
          ))}
        </div>
      </fieldset>
      <label className="field"><span>Note (optional)</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
      </label>
      <p className="small muted">Rejected items are kept with their reason and used as a learning signal. You can reverse this at any time.</p>
    </Dialog>
  );
}

export function PublishedDialog({ refLabel, onCancel, onConfirm }: { refLabel: string; onCancel: () => void; onConfirm: (c: StatusChange) => void }) {
  const [platform, setPlatform] = useState('instagram');
  const [permalink, setPermalink] = useState('');
  const [publishedOn, setOn] = useState(new Date().toISOString().slice(0, 10));
  return (
    <Dialog
      title={`Record manual publication of ${refLabel}`}
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onConfirm({ status: 'manually_published', publication: { platform, permalink: permalink || undefined, publishedOn } })}>Record</button>
        </>
      }
    >
      <p className="notice">This only records that <b>you</b> published it yourself, outside RADAR. RADAR does not post, schedule or contact any platform, and does not verify the link.</p>
      <label className="field"><span>Platform</span>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="instagram">Instagram</option>
          <option value="x">X</option>
          <option value="tumblr">Tumblr</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label className="field"><span>Link to your post (optional)</span>
        <input type="url" value={permalink} onChange={(e) => setPermalink(e.target.value)} placeholder="https://" />
      </label>
      <label className="field"><span>Published on</span>
        <input type="date" value={publishedOn} onChange={(e) => setOn(e.target.value)} />
      </label>
    </Dialog>
  );
}
