/** Download jobs with progress (phone: on top of the search screen; desktop: the Download screen). */
import { Icon } from '../icons';
import { t } from '../../i18n';
import { cancel, clearFinished, useDlJobs, type DlJob } from '../../core/download';

export function JobRow({ j }: { j: DlJob }) {
  const live = j.state === 'queued' || j.state === 'running';
  const n = 24, on = Math.floor(j.progress * n);
  return (
    <div className={'dl-job ' + j.state}>
      <div className="dl-jt">
        <div><b>{j.artist ? `${j.artist} — ${j.title}` : j.title}</b><span>{j.message}</span></div>
        {j.state === 'done' ? <Icon n="check" s={18} /> : j.state === 'failed' ? <Icon n="info" s={18} />
          : <button className="dl-x" title={t('Отменить')} onClick={() => cancel(j.id)}><Icon n="x" s={16} /></button>}
      </div>
      {live && <div className="dl-seg">{Array.from({ length: n }, (_, i) => <i key={i} className={i < on ? 'on' : ''} />)}</div>}
    </div>
  );
}

export function JobList() {
  const jobs = useDlJobs();
  if (!jobs.length) return null;
  return <div className="dl-jobs">
    <div className="dl-h"><span>{t('Загрузки')}</span>{jobs.some((j) => j.state === 'done' || j.state === 'failed') && <button onClick={clearFinished}>{t('Очистить')}</button>}</div>
    {jobs.slice(0, 12).map((j) => <JobRow key={j.id} j={j} />)}
  </div>;
}
