import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format';
import { ErrorBox, Loading, Seg, errorText, useToast } from './ui';

interface MediaSummary { posts: number; with_media: number; images: number; uploads: number; from_export: number; model: string }
interface ExportResult {
  importId: string | null; postsInExport: number; matchedPosts: number; imagesAdded: number; imagesAlreadyAttached: number;
  videosSkipped: number; missingFiles: number; unreadableImages: number; note: string;
  unmatched: { entry: string; date: string | null; caption: string; reason: string }[];
}
interface MediaImport { id: string; filename: string; account: string | null; images: number; created_at: string; summary: Partial<ExportResult> }
interface PostMedia { id: string; width: number; height: number; origin: 'instagram_export' | 'upload'; matchNote: string }
interface HistPost { id: string; account: string; caption: string | null; permalink: string | null; format: string | null; publishedAt: string | null; media: PostMedia[] }

const imageUrl = (id: string) => `/api/post-media/${id}/image`;

/**
 * eccö's own post images. Analytics exports have none, so the editor supplies them: in bulk from
 * Instagram's "Download your information" ZIP, or one at a time. Only colour and tone are analysed.
 */
export function PostImages() {
  const summary = useQuery({ queryKey: ['post-media', 'summary'], queryFn: () => api.get<MediaSummary>('/api/post-media/summary') });
  const s = summary.data;
  return (
    <div className="stack lg">
      <p className="notice small" style={{ margin: 0 }}>
        Analytics exports contain captions and numbers, not pictures, so post-level insights are text-only until you add images here.
        RADAR keeps a small copy (640 px) of each image on your server, measures colour and tone (colour-tone-v1) and a perceptual
        hash (dhash-64), and uses them to compare references with what eccö has posted. It does not recognise subjects or style, and
        nothing is sent anywhere.
      </p>
      {s ? (
        <div className="grid3">
          <div className="stat"><div className="l">Instagram posts with images</div><div className="v">{fmtNum(s.with_media)} of {fmtNum(s.posts)}</div></div>
          <div className="stat"><div className="l">Images stored</div><div className="v">{fmtNum(s.images)}</div><div className="small muted">{fmtNum(s.from_export)} from exports · {fmtNum(s.uploads)} added by hand</div></div>
        </div>
      ) : <ErrorBox error={summary.error} retry={() => summary.refetch()} />}
      <ExportImport disabled={!!s && s.posts === 0} />
      <MediaImports />
      <PostList />
    </div>
  );
}

function ExportImport({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [account, setAccount] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null);
  const run = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('file', file!);
      const q = account.trim() ? `?account=${encodeURIComponent(account.trim().replace(/^@/, ''))}` : '';
      return api.post<ExportResult>(`/api/post-media/instagram-export${q}`, fd);
    },
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['post-media'] });
      qc.invalidateQueries({ queryKey: ['insights'] });
    },
  });
  return (
    <section className="panel">
      <header><h2>Import from an Instagram download</h2></header>
      <div className="body stack">
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>In Instagram: Settings → Accounts Center → Your information and permissions → Download your information.</li>
          <li>Choose the eccö account and “Some of your information”, then tick <b>Content</b> (your posts).</li>
          <li>Pick <b>JSON</b> as the format. Lower media quality keeps the file small and is enough for colour and tone.</li>
          <li>When Instagram emails you, download the ZIP and choose it below without unzipping it.</li>
        </ol>
        <p className="small muted" style={{ margin: 0 }}>
          Each exported post is tied to a post you imported from the analytics CSV by its caption and date. When that is not clear
          (a repeated caption, no caption, no matching post) the post is listed below and left alone rather than guessed.
        </p>
        {disabled ? <p className="notice warn small" style={{ margin: 0 }}>Import the Instagram analytics CSV first (Imports tab): images are attached to those posts.</p> : null}
        <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); if (file) run.mutate(); }}>
          <label className="field">
            <span className="small">Instagram ZIP</span>
            <input type="file" accept=".zip,application/zip" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} disabled={disabled || run.isPending} />
          </label>
          <label className="field">
            <span className="small">Only posts from account (optional)</span>
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="handle without @" disabled={disabled || run.isPending} />
          </label>
          <button className="primary" type="submit" disabled={!file || disabled || run.isPending}>{run.isPending ? 'Importing…' : 'Import images'}</button>
        </form>
        {run.isPending ? <Loading label="Uploading and analysing the images. A large download can take several minutes; keep this page open" /> : null}
        <ErrorBox error={run.error} />
        {result ? <ExportResultView r={result} /> : null}
      </div>
    </section>
  );
}

function ExportResultView({ r }: { r: ExportResult }) {
  return (
    <div className="stack">
      <div className={`notice small ${r.imagesAdded ? 'ok' : 'warn'}`}>
        <b>{fmtNum(r.imagesAdded)} image(s) added</b> to {fmtNum(r.matchedPosts)} of {fmtNum(r.postsInExport)} exported posts.
        {r.imagesAlreadyAttached ? ` ${fmtNum(r.imagesAlreadyAttached)} were already attached.` : ''}
        {r.missingFiles ? ` ${fmtNum(r.missingFiles)} image file(s) listed in the export were not in the ZIP.` : ''}
        {r.unreadableImages ? ` ${fmtNum(r.unreadableImages)} file(s) could not be read as images.` : ''}
        <div>{r.note}</div>
      </div>
      {r.unmatched.length ? (
        <details>
          <summary className="small">{fmtNum(r.unmatched.length)} exported post(s) left unmatched</summary>
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>Date</th><th>Caption</th><th>Why</th></tr></thead>
              <tbody>
                {r.unmatched.slice(0, 200).map((u) => (
                  <tr key={u.entry}><td className="small nowrap">{u.date ? fmtDate(u.date) : '—'}</td><td className="small">{u.caption || <span className="muted">(no caption)</span>}</td><td className="small">{u.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">You can attach images to the remaining posts one at a time in the list below.</p>
        </details>
      ) : null}
    </div>
  );
}

function MediaImports() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['post-media', 'imports'], queryFn: () => api.get<MediaImport[]>('/api/post-media/imports') });
  const done = (text: string) => {
    qc.invalidateQueries({ queryKey: ['post-media'] });
    qc.invalidateQueries({ queryKey: ['insights'] });
    toast({ text });
  };
  const undo = useMutation({
    mutationFn: (id: string) => api.del<{ removed: number }>(`/api/post-media/imports/${id}`),
    onSuccess: (r) => done(`${r.removed} image(s) removed`),
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const removeAll = useMutation({
    mutationFn: () => api.del<{ removed: number }>('/api/post-media'),
    onSuccess: (r) => done(`${r.removed} image(s) removed`),
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  if (!list.data?.length) return <ErrorBox error={list.error} />;
  return (
    <section className="panel">
      <header>
        <h2>Image imports</h2>
        <button className="sm danger" onClick={() => window.confirm('Remove every stored post image, including ones added by hand? Your posts and metrics stay.') && removeAll.mutate()}>Remove all post images</button>
      </header>
      <div className="body scroll-x">
        <table className="data">
          <thead><tr><th>When</th><th>File</th><th>Account</th><th className="num">Images</th><th className="num">Unmatched</th><th /></tr></thead>
          <tbody>
            {list.data.map((i) => (
              <tr key={i.id}>
                <td className="small nowrap">{fmtDateTime(i.created_at)}</td>
                <td className="small">{i.filename}</td>
                <td className="mono">{i.account ?? 'all'}</td>
                <td className="num">{fmtNum(i.images)}</td>
                <td className="num">{fmtNum(i.summary.unmatched?.length ?? 0)}</td>
                <td className="right"><button className="sm" onClick={() => window.confirm('Remove the images this import added?') && undo.mutate(i.id)}>Undo</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const PAGE = 30;

function PostList() {
  const [filter, setFilter] = useState<'without' | 'with'>('without');
  const [limit, setLimit] = useState(PAGE);
  const q = useQuery({
    queryKey: ['post-media', 'posts', filter, limit],
    queryFn: () => api.get<{ total: number; posts: HistPost[] }>(`/api/historical-posts?media=${filter}&limit=${limit}`),
  });
  return (
    <section className="panel">
      <header>
        <h2>Posts</h2>
        <Seg label="Show" value={filter} onChange={(v) => { setFilter(v); setLimit(PAGE); }} options={[{ value: 'without', label: 'Without images' }, { value: 'with', label: 'With images' }]} />
      </header>
      <div className="body">
        {q.isLoading ? <Loading /> : null}
        <ErrorBox error={q.error} retry={() => q.refetch()} />
        {q.data && q.data.total === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>{filter === 'without' ? 'Every imported Instagram post has an image.' : 'No post has an image yet.'}</p>
        ) : null}
        {q.data?.posts.length ? (
          <ul className="post-images-list">{q.data.posts.map((p) => <PostItem key={p.id} p={p} />)}</ul>
        ) : null}
        {q.data && q.data.total > q.data.posts.length ? (
          <button className="sm" onClick={() => setLimit((l) => Math.min(l + PAGE, 100))} disabled={limit >= 100}>
            {limit >= 100 ? `Showing the first 100 of ${fmtNum(q.data.total)}` : `Show more (${fmtNum(q.data.total - q.data.posts.length)} more)`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function PostItem({ p }: { p: HistPost }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['post-media'] });
    qc.invalidateQueries({ queryKey: ['insights'] });
  };
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.post(`/api/historical-posts/${p.id}/media`, fd);
    },
    onSuccess: () => { refresh(); toast({ text: 'Image added' }); },
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/post-media/${id}`),
    onSuccess: refresh,
    onError: (e) => toast({ text: errorText(e), error: true }),
  });
  const label = `${fmtDate(p.publishedAt)} post`;
  return (
    <li>
      <div className="thumbs">
        {p.media.length ? p.media.map((m) => (
          <div key={m.id} className="thumb-wrap">
            <img className="post-thumb" src={imageUrl(m.id)} alt={`Image ${m.id.slice(0, 4)} of the ${label}`} loading="lazy" title={m.matchNote} />
            <button className="sm" aria-label={`Remove this image from the ${label}`} title="Remove image" onClick={() => window.confirm('Remove this image?') && remove.mutate(m.id)}>×</button>
          </div>
        )) : <div className="empty-thumb">No image</div>}
      </div>
      <div className="stack" style={{ minWidth: 0, gap: 2 }}>
        <div className="small">
          {p.permalink ? <a href={p.permalink} target="_blank" rel="noopener noreferrer">{fmtDate(p.publishedAt)} · @{p.account}</a> : `${fmtDate(p.publishedAt)} · @${p.account}`}
          {p.format ? <span className="muted"> · {p.format}</span> : null}
        </div>
        <div className="small muted">{p.caption || '(no caption)'}</div>
        {p.media[0] ? <div className="small muted">{p.media[0].matchNote}</div> : null}
      </div>
      <span className="file-pick">
        <span className="btn sm" aria-hidden="true">{upload.isPending ? 'Adding…' : 'Add image'}</span>
        <input
          type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" aria-label={`Add an image to the ${label}`}
          disabled={upload.isPending}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }}
        />
      </span>
    </li>
  );
}
