import { useEffect, useState } from 'react';
import { api, isMobile } from '../app/api';
import { Icon } from './icons';
import { setState, useStore } from '../app/store';
import type { Track } from '../core/types';
import { fmtTime } from '../core/util';
import { Cover } from './Cover';
import { t as tr } from '../i18n';

export function QueuePanel() {
  const p = useStore((s) => s.player);
  const [list, setList] = useState<Track[]>([]);
  useEffect(() => { api.queueTracks().then(setList); }, [p.queue, p.index]);
  return (
    <div className="pop">
      <div className="ph">{tr('Очередь')}<span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>{list.length}</span>
        <button onClick={() => setState({ panel: 'none' })}><Icon n="x" s={14} /></button></div>
      <div className="pb">
        {list.length === 0 && <div className="muted" style={{ padding: '6px 8px 10px' }}>{tr('Очередь пуста')}</div>}
        {list.map((t, i) => (
          <div key={i + ':' + t.id}>
            {i === p.index && <div className="qsec">{tr('Сейчас')}</div>}
            {i === p.index + 1 && <div className="qsec">{tr('Далее')}</div>}
            <div className={'qi' + (i === p.index ? ' on' : '')} onDoubleClick={() => api.jump(i)} onClick={isMobile ? () => api.jump(i) : undefined} style={i < p.index ? { opacity: 0.45 } : undefined}>
              <Cover a={{ id: t.album_id, cover: null, recipe: null, title: t.album, artist: t.artist, genre: t.genre }} size={34} />
              <div><b>{t.title}</b><span>{t.artist}</span></div>
              <span className="d">{fmtTime(t.dur)}</span>
              {i !== p.index && <button className="x" onClick={() => api.removeFromQueue(i)}><Icon n="x" s={13} /></button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
