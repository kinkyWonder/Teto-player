/** The shareable picture of a report (1080×1920, story format), drawn on a canvas in the colours of the theme. */
import type { Report } from './data';
import { albumHasCover, coverUrl, isMobile, isTauri, call } from '../app/api';
import { coverImage, themedRecipe } from '../cover/gen';
import { prefs } from '../core/prefs';
import { defaultRecipe } from '../cover/draw';
import { getState } from '../app/store';
import { themeKey } from '../core/look';
import { t } from '../i18n';
import { fmtNum } from '../core/util';

const W = 1080, H = 1920;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgb = (n: string, a = 1) => `rgba(${css(n) || '255,255,255'},${a})`;
const load = (src: string) => new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = bad; i.src = src; });

async function coverOf(id: number, title: string, artist: string, genre: string): Promise<HTMLImageElement | null> {
  if (!isMobile || albumHasCover(id)) { try { return await load(coverUrl(id, 300)); } catch { /* generated below */ } }
  try {
    const r = themedRecipe(defaultRecipe(`${artist}|${title || id}`, genre, id, title), themeKey(getState().settings.theme), prefs().coverStyle);
    return await load(await coverImage(r, 300));
  } catch { return null; }
}
function round(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function fit(c: CanvasRenderingContext2D, s: string, w: number) {
  if (c.measureText(s).width <= w) return s;
  while (s.length > 1 && c.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}

export async function drawShare(r: Report): Promise<HTMLCanvasElement> {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const bg = css('--bg') || '#000', t1 = css('--t1') || '#fff';
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  const glow = (x: number, y: number, rad: number, col: string) => { const g = c.createRadialGradient(x, y, 0, x, y, rad); g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H); };
  glow(W * 0.15, H * 0.12, 900, rgb('--acc', 0.42)); glow(W * 0.95, H * 0.55, 800, rgb('--acc2', 0.28)); glow(W * 0.3, H * 1.02, 700, rgb('--acc', 0.22));
  c.textBaseline = 'alphabetic';
  // header
  c.fillStyle = rgb('--acc'); c.font = `700 34px ${font}`; c.fillText('TETO · ' + `${r.label} ${r.year}`.toUpperCase(), 80, 150);
  c.fillStyle = t1; c.font = `800 210px ${font}`; c.fillText(fmtNum(Math.round(r.secs / 60)), 72, 380);
  c.globalAlpha = 0.75; c.font = `500 46px ${font}`; c.fillText(t('минут музыки'), 82, 450); c.globalAlpha = 1;
  // top artist
  const a = r.topArtists[0];
  let y = 560;
  if (a) {
    const img = await coverOf(a.album_id, a.album, a.name, a.genre);
    c.save(); c.beginPath(); c.arc(80 + 110, y + 110, 110, 0, Math.PI * 2); c.clip();
    if (img) c.drawImage(img, 80, y, 220, 220); else { c.fillStyle = rgb('--acc', 0.4); c.fillRect(80, y, 220, 220); }
    c.restore();
    c.fillStyle = t1; c.globalAlpha = 0.6; c.font = `600 30px ${font}`; c.fillText(t('Исполнитель месяца').toUpperCase(), 340, y + 70); c.globalAlpha = 1;
    c.font = `800 72px ${font}`; c.fillText(fit(c, a.name, W - 420), 340, y + 150);
    c.globalAlpha = 0.7; c.font = `500 34px ${font}`; c.fillText(t('{0} ч · {1} прослушиваний', (a.secs / 3600).toFixed(1), a.plays), 340, y + 200); c.globalAlpha = 1;
    y += 300;
  }
  // top songs
  c.fillStyle = t1; c.globalAlpha = 0.6; c.font = `600 30px ${font}`; c.fillText(t('Песни месяца').toUpperCase(), 80, y + 30); c.globalAlpha = 1;
  y += 60;
  for (const [i, s] of r.topTracks.slice(0, 5).entries()) {
    c.fillStyle = rgb('--ov', 0.06); round(c, 64, y, W - 128, 120, 28); c.fill();
    const img = await coverOf(s.album_id, s.album, s.artist, s.genre);
    c.save(); round(c, 84, y + 14, 92, 92, 16); c.clip(); if (img) c.drawImage(img, 84, y + 14, 92, 92); c.restore();
    c.fillStyle = rgb('--acc'); c.font = `800 40px ${font}`; c.fillText(String(i + 1), 200, y + 74);
    c.fillStyle = t1; c.font = `700 38px ${font}`; c.fillText(fit(c, s.title, W - 470), 250, y + 56);
    c.globalAlpha = 0.65; c.font = `500 30px ${font}`; c.fillText(fit(c, s.artist, W - 470), 250, y + 96); c.globalAlpha = 1;
    c.textAlign = 'right'; c.font = `700 32px ${font}`; c.fillText('×' + s.plays, W - 92, y + 74); c.textAlign = 'left';
    y += 136;
  }
  // stats
  y += 30;
  const stats: [string, string][] = [[fmtNum(r.plays), t('прослушиваний')], [`${r.days}/${r.daysInMonth}`, t('дней с музыкой')], [fmtNum(r.artists), t('исполнителей')]];
  stats.forEach(([v, l], i) => {
    const x = 80 + i * 320;
    c.fillStyle = t1; c.font = `800 64px ${font}`; c.fillText(v, x, y + 60);
    c.globalAlpha = 0.65; c.font = `500 28px ${font}`; c.fillText(l, x, y + 104); c.globalAlpha = 1;
  });
  y += 170;
  // persona + tags
  c.fillStyle = rgb('--acc'); round(c, 64, y, W - 128, 190, 36); c.fill();
  c.fillStyle = css('--on-acc') || '#000'; c.font = `800 60px ${font}`; c.fillText(fit(c, r.persona.title, W - 200), 104, y + 84);
  c.font = `500 30px ${font}`; c.fillText(fit(c, r.tags.slice(0, 3).map((x) => x.name).join(' · ') || r.persona.text, W - 200), 104, y + 140);
  c.fillStyle = t1; c.globalAlpha = 0.5; c.font = `600 28px ${font}`; c.fillText('Teto Player', 80, H - 70); c.globalAlpha = 1;
  return cv;
}

const toBlob = (cv: HTMLCanvasElement) => new Promise<Blob>((ok, bad) => cv.toBlob((b) => (b ? ok(b) : bad(new Error('png'))), 'image/png'));
const b64 = (blob: Blob) => new Promise<string>((ok) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1] ?? ''); fr.readAsDataURL(blob); });

/** Phone: system share sheet. Desktop: save as PNG (dialog). Browser preview: download. */
export async function shareReport(r: Report): Promise<string> {
  const blob = await toBlob(await drawShare(r));
  const name = `teto-${r.month}.png`;
  if (isMobile && !isTauri) {
    try { const { native } = await import('../mobile/native'); await native.plugin.shareImage({ data: await b64(blob), name, title: t('Мой месяц в Teto') }); return ''; } catch { /* browser preview */ }
  }
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: name, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!path) return '';
    await call('save_png', { path, data: Array.from(new Uint8Array(await blob.arrayBuffer())) });
    return t('Картинка сохранена');
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return t('Картинка сохранена');
}
export async function copyReport(r: Report): Promise<string> {
  const blob = await toBlob(await drawShare(r));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return t('Картинка скопирована');
}
