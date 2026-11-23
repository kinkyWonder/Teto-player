/** One internet result (search / "Download" screen): cover, names, source, download button with a progress ring. */
import { memo, useState } from 'react';
import { Icon } from '../icons';
import { t } from '../../i18n';
import { fmtTime } from '../../core/util';
import { enqueue, SOURCE_LABEL, type DlItem, type DlJob, type DlMeta } from '../../core/download';

export const NetRow = memo(function NetRow({ r, job, i = 0, meta }: { r: DlItem; job?: DlJob; i?: number; meta?: DlMeta }) {
  const [broken, setBroken] = useState(false);
  const busy = !!job && (job.state === 'queued' || job.state === 'running');
  const done = job?.state === 'done';
  const sub = job && job.state !== 'failed' ? job.message
    : [r.artist, r.album && r.album !== r.title ? r.album : '', r.dur ? fmtTime(r.dur) : ''].filter(Boolean).join('  ·  ');
  return (
    <button className={'nr' + (busy ? ' busy' : '') + (done ? ' done' : '')} style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
      onClick={() => enqueue(r, meta)} disabled={busy || done}>
      <span className="nr-art">
        {r.thumb && !broken ? <img src={r.thumb} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <Icon n="disc" s={18} />}
        <i className={'nr-src ' + r.source} title={t(SOURCE_LABEL[r.source])} />
      </span>
      <span className="nr-t"><b>{r.title}</b><span>{sub}</span></span>
      {r.song && <span className="nr-tag">{r.source === 'vk' ? 'VK' : t('трек')}</span>}
      <span className="nr-go" style={{ ['--p' as string]: busy ? Math.max(0.04, job!.progress) : 0 }}>
        <Icon n={done ? 'check' : 'download'} s={17} />
      </span>
    </button>
  );
});

/** Shimmering placeholders while the internet is asked. */
export function NetSkeleton({ n = 4 }: { n?: number }) {
  return <div className="nr-list">{Array.from({ length: n }, (_, i) => <div key={i} className="nr sk" style={{ animationDelay: `${i * 90}ms` }}><span className="nr-art" /><span className="nr-t"><b /><span /></span></div>)}</div>;
}
