import { useEffect, useState } from 'react';
import { isIOS } from '../app/platform';
import { api, call } from '../app/api';
import { Icon } from '../ui/icons';
import { setState, toast, useStore } from '../app/store';
import type { Settings } from '../core/types';
import { AuthorRow, CoverStyleRow, DownloadRow, LangRow, LayoutRow, ReportsRow, VizSceneRows, themeEntries } from '../ui/settings/MoreSettings';
import { importFiles } from './MobileApp';
import { fmtNum, fmtTime, plural } from '../core/util';
import { t } from '../i18n';
import { themeKey } from '../core/look';
import { prefs, setPrefs } from '../core/prefs';
import { usePrefsLite } from '../core/prefsHook';
import type { DeviceAudio } from './native';
import { DevSection, versionTap } from '../ui/settings/DevMode';

const save = async (p: Partial<Settings>) => setState({ settings: await api.setSettings(p) });
const Toggle = ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => <button className={'tg' + (on ? ' on' : '')} onClick={() => onChange(!on)} />;
const Row = ({ title, d, children }: { title: string; d?: string; children?: React.ReactNode }) => <div className="srow"><div><b>{title}</b>{d && <span>{d}</span>}</div>{children}</div>;

/** Phone settings: only what makes sense on a phone. Fine-tuning lives in developer mode (tap the version 7 times). */
export function MobileSettings() {
  const s = useStore((x) => x.settings);
  const st = useStore((x) => x.stats);
  const [info, setInfo] = useState<{ version: string; data: string } | null>(null);
  useEffect(() => { api.appInfo().then(setInfo).catch(() => {}); }, []);
  const theme = themeKey(s.theme);
  usePrefsLite();
  return (
    <div className="set m-set">
      <div className="ptitle">{t('Настройки')}</div>

      <h3>{t('Оформление')}</h3>
      <LayoutRow />
      <div className="m-themes">
        {themeEntries().map(([k, x]) => (
          <button key={k} className={theme === k ? 'on' : ''} onClick={() => save({ theme: k })}>
            <i style={{ background: `linear-gradient(135deg, ${x.acc}, ${x.acc2})`, boxShadow: `0 0 0 4px ${x.bg} inset, 0 0 0 1px rgba(128,128,128,.25)` }} /><span>{t(x.name)}</span>
          </button>
        ))}
      </div>
      <CoverStyleRow />
      <Row title={t('Аура обложки')} d={t('Мягкий фон из цветов обложки')}><Toggle on={s.glow} onChange={(v) => save({ glow: v })} /></Row>
      <LangRow />

      <h3>{t('Медиатека')}</h3>
      <Row title={`${fmtNum(st.tracks)} ${plural(st.tracks, 'трек', 'трека', 'треков')}`} d={t('Песни хранятся внутри приложения')}><button className="btn pri" onClick={importFiles}><Icon n="import" />{t('Импорт')}</button></Row>
      <ScanSection />
      <div className="note"><Icon n="info" s={14} />{isIOS ? t('Песни можно добавить через «Поделиться» → Teto или положить в «Файлы» → «На iPhone» → «Teto» (они подхватятся при следующем открытии).') : t('Чтобы добавить песню из Telegram, браузера или файлового менеджера, нажмите «Поделиться» → Teto.')} {t('Обложку можно заменить фото: «⋯» → «Редактировать» → «Заменить обложку фото…».')}</div>

      <h3>{t('Скачивание')}</h3>
      <DownloadRow />

      <h3>{t('Воспроизведение')}</h3>
      <LevelRow />

      <h3>{t('3D-визуализация')}</h3>
      <VizSceneRows />

      <h3>{t('Итоги месяца')}</h3>
      <ReportsRow />

      <h3>{t('О приложении')}</h3>
      <div onClick={versionTap}><Row title={`Teto ${info?.version ?? ''}`} d={prefs().dev ? t('Режим разработчика включён') : t('Без рекламы и слежки, аккаунт не нужен')} /></div>
      <AuthorRow />
      {prefs().dev && <DevSection />}
    </div>
  );
}

const parseMmss = (v: string): number | null => {
  const m = v.trim().match(/^(\d{1,3})(?::([0-5]?\d))?$/);
  return m ? +m[1] * (m[2] !== undefined ? 60 : 1) + (m[2] !== undefined ? +m[2] : 0) : null;
};

/** Settings → Scan: find all audio on the phone and add every new song to the library right away. */
function ScanSection() {
  const p = usePrefsLite();
  const [min, setMin] = useState(fmtTime(p.scanMin));
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    try {
      const r = await call<{ items: DeviceAudio[]; unsupported: boolean }>('scan_device', { minSec: prefs().scanMin });
      if (r.unsupported) { toast(t('На iPhone другие приложения не дают доступ к своим файлам. Положите песни в «Файлы» → «На iPhone» → «Teto» — они уже подхвачены.')); return; }
      if (!r.items.length) { toast(t('Новых песен не найдено')); return; }
      await call('import_uris', { uris: r.items.map((x) => x.uri) });
      toast(t('Добавляю в медиатеку: {0}', r.items.length));
    } catch (e) {
      toast(/PERMISSION|permission/.test(String(e)) ? t('Нет доступа к музыке. Разрешите его в настройках Android → Приложения → Teto → Разрешения.') : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Row title={t('Сканировать телефон')} d={t('Найти всю музыку на телефоне и сразу добавить в Teto. Файлы короче указанного времени (голосовые, звуки) пропускаются')}>
      <input className="mmss" value={min} inputMode="numeric" placeholder="1:00" title={t('Минимальная длина, мм:сс')}
        onChange={(e) => { setMin(e.target.value); const v = parseMmss(e.target.value); if (v !== null) setPrefs({ scanMin: v }); }}
        onBlur={() => setMin(fmtTime(prefs().scanMin))} />
      <button className="btn pri" disabled={busy} onClick={scan}><Icon n={busy ? 'refresh' : 'search'} />{busy ? t('Ищу…') : t('Сканировать')}</button>
    </Row>
  );
}

/** Volume leveling: the phone measures every song's loudness in the background (also downloaded ones). */
function LevelRow() {
  const s = useStore((x) => x.settings);
  const [st, setSt] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (s.replaygain === 'off') return;
    const f = () => call<{ done: number; total: number }>('level_stats').then(setSt).catch(() => {});
    f(); const id = setInterval(f, 3000); return () => clearInterval(id);
  }, [s.replaygain]);
  const left = st ? st.total - st.done : 0;
  return (
    <Row title={t('Выравнивание громкости')} d={s.replaygain === 'off' ? t('Громкие и тихие песни звучат как записаны') : t('Слишком громкие песни приглушаются до общего уровня') + (left > 0 ? ' · ' + t('измеряю: осталось {0}', fmtNum(left)) : '')}>
      <div className="seg">{([['off', 'Выкл'], ['track', 'По песне'], ['album', 'По альбому']] as const).map(([k, l]) => <button key={k} className={s.replaygain === k ? 'on' : ''} onClick={() => save({ replaygain: k })}>{t(l)}</button>)}</div>
    </Row>
  );
}
