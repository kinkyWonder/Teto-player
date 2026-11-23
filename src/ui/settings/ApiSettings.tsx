/** Desktop: Settings → «Трансляция для других программ» — the local now-playing API (src-tauri/src/nowplaying.rs, docs/API.md). */
import { useEffect, useState } from 'react';
import { api, call } from '../../app/api';
import { setState, toast, useStore } from '../../app/store';
import type { ApiCfg, Settings } from '../../core/types';
import { Icon } from '../icons';
import { t } from '../../i18n';

const DEF: ApiCfg = { enabled: false, port: 7710, files: false, pipe: true, control: false, allow_web: false, token: '' };
interface Status { running: boolean; message: string; port: number; clients: number; pipe: string; files: string }

const Row = ({ title, d, children }: { title: string; d?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="srow"><div><b>{title}</b>{d && <span>{d}</span>}</div>{children}</div>
);
const Toggle = ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => <button className={'tg' + (on ? ' on' : '')} onClick={() => onChange(!on)} />;

export function ApiSection() {
  const s = useStore((x) => x.settings);
  const c: ApiCfg = { ...DEF, ...(s.api ?? {}) };
  const [st, setSt] = useState<Status | null>(null);
  const [port, setPort] = useState(String(c.port));
  const [show, setShow] = useState(false);
  useEffect(() => setPort(String(c.port)), [c.port]);
  useEffect(() => {
    let live = true;
    const f = () => call<Status>('api_status').then((x) => live && setSt(x)).catch(() => {});
    f();
    const id = window.setInterval(f, 2000);
    return () => { live = false; clearInterval(id); };
  }, []);
  const save = async (p: Partial<ApiCfg>) => setState({ settings: await api.setSettings({ api: { ...c, ...p } } as Partial<Settings>) });
  const base = `http://127.0.0.1:${c.port}`;
  const copy = (x: string) => navigator.clipboard?.writeText(x).then(() => toast(t('Скопировано')), () => toast(x));
  const commitPort = () => { const n = Math.round(+port); if (n >= 1024 && n <= 65535 && n !== c.port) save({ port: n }); else setPort(String(c.port)); };

  return (
    <>
      <Row title={t('Трансляция для других программ')} d={<span className={'dst' + (st?.running ? ' ok' : '')}><i />{!c.enabled ? t('Отдавать название, исполнителя, таймкод и текущую строку текста OBS, оверлеям, ботам и скриптам на этом компьютере') : !st ? '…' : st.running ? t('Работает: {0}', base) : t('Не запустилось: {0}', st.message)}</span>}>
        <Toggle on={c.enabled} onChange={(v) => save({ enabled: v })} />
      </Row>
      {c.enabled && <>
        <Row title={t('Порт')} d={t('Только 127.0.0.1 — из сети и интернета недоступно')}>
          <input className="inp mono" style={{ width: 90 }} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} onBlur={commitPort} onKeyDown={(e) => e.key === 'Enter' && commitPort()} />
        </Row>
        <Row title={t('Адреса')} d={<span className="mono">{base}/v1/now · /v1/events · /v1/ws · /overlay</span>}>
          <button className="btn" onClick={() => call('open_url', { url: base + '/' })}><Icon n="info" s={14} />{t('Справка')}</button>
          <button className="btn" onClick={() => copy(base)}>{t('Скопировать')}</button>
        </Row>
        <Row title={t('Оверлей для OBS')} d={t('Источник «Браузер» с этим адресом: обложка, название, текущая строка, полоса прогресса. Фон прозрачный')}>
          <button className="btn" onClick={() => copy(base + '/overlay')}>{t('Скопировать адрес')}</button>
          <button className="btn" onClick={() => call('open_url', { url: base + '/overlay' })}>{t('Открыть')}</button>
        </Row>
        <Row title={t('Именованный канал')} d={t('Для своих программ: \\\\.\\pipe\\teto-player — события по одной JSON-строке')}><Toggle on={c.pipe} onChange={(v) => save({ pipe: v })} /></Row>
        <Row title={t('Файлы для OBS')} d={c.files && st?.files ? <span className="mono">{st.files}</span> : t('track.txt, title.txt, artist.txt, line.txt, next_line.txt, now.json, cover.jpg — для «Текст из файла»')}>
          {c.files && st?.files && <button className="btn" onClick={() => api.revealFile(st.files)}><Icon n="folder" s={14} />{t('Папка')}</button>}
          <Toggle on={c.files} onChange={(v) => save({ files: v })} />
        </Row>
        <Row title={t('Разрешить управление')} d={t('Пауза, следующий трек, перемотка, громкость и «скачать по ссылке» через POST /v1/control/… — только с токеном')}>
          <Toggle on={c.control} onChange={(v) => save({ control: v })} />
        </Row>
        {c.control && (
          <Row title={t('Токен')} d={<span className="mono">{show ? c.token : '•'.repeat(Math.min(24, c.token.length || 24))}</span>}>
            <button className="btn" onClick={() => setShow((x) => !x)}>{show ? t('Скрыть') : t('Показать')}</button>
            <button className="btn" onClick={() => copy(c.token)}>{t('Скопировать')}</button>
            <button className="btn" onClick={async () => { setState({ settings: await call<Settings>('api_new_token') }); toast(t('Новый токен: старый больше не работает')); }}><Icon n="refresh" s={14} />{t('Новый')}</button>
          </Row>
        )}
        <Row title={t('Разрешить сайтам')} d={t('Обычно выключено: страницы из интернета, открытые в браузере, не смогут узнать, что вы слушаете. OBS, локальные страницы и программы работают всегда')}>
          <Toggle on={c.allow_web} onChange={(v) => save({ allow_web: v })} />
        </Row>
        {!!st?.clients && <div className="note"><Icon n="info" s={14} />{t('Подключено программ: {0}', st.clients)}</div>}
      </>}
    </>
  );
}
