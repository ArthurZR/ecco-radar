import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { STATUS_LABEL, type Status } from '../lib/types';
import { fmtNum } from '../lib/format';
import { Empty, ErrorBox, Loading, Seg, StatusBadge, Thumb } from './ui';

type Basis = 'text' | 'visual';
interface Cluster {
  index: number;
  size: number;
  cohesion: number;
  sharedTags: { tag: string; share: number }[];
  statusCounts: Record<string, number>;
  members: { refNumber: number; refLabel: string; title: string | null; creatorName: string | null; thumbnailUrl: string | null; status: Status }[];
}
interface ClusterResult { basis: Basis; model: string; considered: number; withoutVector: number; truncated: boolean; clusters: Cluster[]; note: string }

/** Editorial outcome inside a group, in the order an editor reads it. */
const OUTCOME: Status[] = ['approved_consideration', 'caption_draft', 'reviewed', 'approved_publication', 'manually_published', 'saved', 'discovered', 'archived'];

export function Clusters() {
  const [basis, setBasis] = useState<Basis>('text');
  const q = useQuery({ queryKey: ['clusters', basis], queryFn: () => api.get<ClusterResult>(`/api/clusters${qs({ basis })}`) });
  return (
    <div className="stack lg">
      <div className="row between">
        <Seg label="Group by" value={basis} onChange={setBasis} options={[{ value: 'text', label: 'Wording' }, { value: 'visual', label: 'Colour & tone' }]} />
        {q.data ? (
          <span className="small muted">
            {fmtNum(q.data.considered)} references grouped{q.data.withoutVector ? ` · ${fmtNum(q.data.withoutVector)} without ${basis === 'text' ? 'a text vector' : 'an analysed image'}` : ''}
            {q.data.truncated ? ' · newest 2,000 only' : ''} · rejected references left out
          </span>
        ) : null}
      </div>
      {q.data ? <p className="small muted" style={{ margin: 0 }}>{q.data.note} Groups are descriptive: they change no score and no record.</p> : null}
      {q.isLoading ? <Loading label="Grouping references" /> : null}
      <ErrorBox error={q.error} retry={() => q.refetch()} />
      {q.data && q.data.clusters.length === 0 ? (
        <Empty title="Not enough to group yet">
          <p>
            Grouping needs at least 6 references with {basis === 'text' ? 'text' : 'analysed images'}.
            {basis === 'visual' ? ' Images are analysed in the background when Settings → Image analysis is on.' : ''}
          </p>
        </Empty>
      ) : null}
      <div className="clusters">
        {q.data?.clusters.map((c) => <ClusterPanel key={c.index} c={c} />)}
      </div>
    </div>
  );
}

function ClusterPanel({ c }: { c: Cluster }) {
  const outcome = OUTCOME.filter((s) => c.statusCounts[s]);
  return (
    <section className="panel">
      <header>
        <h2>Group {c.index + 1}</h2>
        <span className="small muted mono" title="Mean similarity of members to the group centre">{fmtNum(c.size)} {c.size === 1 ? 'ref' : 'refs'} · cohesion {c.cohesion.toFixed(2)}</span>
      </header>
      <div className="body stack">
        <div>
          {c.sharedTags.length
            ? c.sharedTags.map((t) => <span key={t.tag} className="tagchip" style={{ paddingRight: 6 }} title={`${Math.round(t.share * 100)}% of the group`}>{t.tag}</span>)
            : <span className="small muted">{c.size === 1 ? 'A single reference: nothing else in the archive is close enough to join it.' : 'Members share no tag; the grouping comes from wording alone.'}</span>}
        </div>
        <div className="stackbar" role="img" aria-label={outcome.map((s) => `${STATUS_LABEL[s]} ${c.statusCounts[s]}`).join(', ')}>
          {outcome.map((s) => <i key={s} className={`st-${s}`} style={{ flexGrow: c.statusCounts[s] }} title={`${STATUS_LABEL[s]}: ${c.statusCounts[s]}`} />)}
        </div>
        <div className="small muted">{outcome.map((s) => `${STATUS_LABEL[s]} ${c.statusCounts[s]}`).join(' · ')}</div>
        <ul className="cluster-members">
          {c.members.map((m) => (
            <li key={m.refNumber}>
              <Link to={`/ref/${m.refNumber}`} title={m.title ?? m.refLabel}>
                <Thumb src={m.thumbnailUrl} alt={m.title ?? m.refLabel} />
                <span className="row tight between"><span className="mono small">{m.refLabel}</span><StatusBadge status={m.status} /></span>
                <span className="small cluster-title">{m.title ?? <span className="muted">Untitled</span>}</span>
              </Link>
            </li>
          ))}
        </ul>
        {c.size > c.members.length ? <p className="small muted" style={{ margin: 0 }}>Showing the {c.members.length} closest to the centre of {fmtNum(c.size)}.</p> : null}
      </div>
    </section>
  );
}
