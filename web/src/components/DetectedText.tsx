import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { errorText, useToast } from './ui';

export interface DetectedText {
  outcome: 'found' | 'none' | 'failed';
  text: string | null;
  confidence: number | null;
  wordCount: number;
  model: string;
  error: string | null;
  analyzedAt: string;
  reviewState: 'suggested' | 'confirmed' | 'corrected' | 'rejected';
  correctedText: string | null;
  confirmedText: string | null;
}

const STATE_LABEL: Record<DetectedText['reviewState'], string> = {
  suggested: 'suggestion, not checked',
  confirmed: 'confirmed by you',
  corrected: 'corrected by you',
  rejected: 'rejected',
};

/**
 * Text read from the image by local OCR. It stays a suggestion until the editor confirms or
 * corrects it; only then does Caption Studio treat it as a fact.
 */
export function DetectedTextPanel({ refNumber, refKey, d, hasImage }: { refNumber: number; refKey: unknown[]; d: DetectedText | null; hasImage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const done = () => qc.invalidateQueries({ queryKey: refKey });
  const run = useMutation({
    mutationFn: () => api.post<DetectedText>(`/api/references/${refNumber}/detected-text/run`),
    onSuccess: done,
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const review = useMutation({
    mutationFn: (body: { action: 'confirm' | 'reject' | 'reset' } | { action: 'correct'; text: string }) =>
      api.post<DetectedText>(`/api/references/${refNumber}/detected-text/review`, body),
    onSuccess: () => { setEditing(false); done(); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const busy = run.isPending || review.isPending;
  const startEdit = () => { setDraft(d?.correctedText ?? d?.text ?? ''); setEditing(true); };

  const shown = d?.reviewState === 'corrected' ? d.correctedText : d?.text;
  return (
    <div className="detected-text">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Text in the image</h3>
        {d && (d.outcome === 'found' || d.reviewState === 'corrected') ? <span className={`badge ${d.reviewState === 'confirmed' || d.reviewState === 'corrected' ? 'green' : ''}`}>{STATE_LABEL[d.reviewState]}</span> : null}
      </div>
      {!d ? (
        <p className="small muted">{hasImage ? 'Not read yet. RADAR reads it in the background, or now:' : 'No image to read.'}</p>
      ) : d.outcome === 'failed' && d.reviewState !== 'corrected' ? (
        <p className="small muted">Could not be read: {d.error}</p>
      ) : !shown ? (
        <p className="small muted">No legible text found{d.model !== 'editor' ? ` (${d.model}, ${fmtDateTime(d.analyzedAt)})` : ''}.</p>
      ) : (
        <>
          <pre className={`ocr-text${d.reviewState === 'rejected' ? ' rejected' : ''}`}>{shown}</pre>
          <p className="small muted">
            {d.reviewState === 'corrected' ? 'Your transcription.' : `Read by ${d.model}${d.confidence !== null ? `, confidence ${d.confidence}/100` : ''}, ${fmtDateTime(d.analyzedAt)}. Only confident words are kept; stylised type is often misread.`}
            {d.reviewState === 'suggested' ? ' Caption Studio uses it only after you confirm or correct it.' : ''}
            {d.reviewState === 'rejected' ? ' Rejected: not used in search or captions.' : ''}
          </p>
        </>
      )}
      {editing ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); review.mutate({ action: 'correct', text: draft }); }}>
          <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Text as it appears in the image" maxLength={2000} />
          <div className="row">
            <button className="primary sm" type="submit" disabled={busy || !draft.trim()}>Save transcription</button>
            <button className="sm ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="row">
          {d?.outcome === 'found' && d.reviewState !== 'confirmed' && d.reviewState !== 'corrected' ? <button className="sm" disabled={busy} onClick={() => review.mutate({ action: 'confirm' })}>Confirm</button> : null}
          {hasImage || d ? <button className="sm" disabled={busy} onClick={startEdit}>{shown ? 'Correct…' : 'Type the text…'}</button> : null}
          {shown && d?.reviewState !== 'rejected' ? <button className="sm ghost" disabled={busy} onClick={() => review.mutate({ action: 'reject' })}>Reject</button> : null}
          {d && d.reviewState !== 'suggested' ? <button className="sm ghost" disabled={busy} onClick={() => review.mutate({ action: 'reset' })}>Undo review</button> : null}
          {hasImage ? <button className="sm ghost" disabled={busy} onClick={() => run.mutate()}>{run.isPending ? 'Reading…' : d ? 'Read again' : 'Read now'}</button> : null}
        </div>
      )}
    </div>
  );
}
