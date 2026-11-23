import { isMobile } from '../app/platform';

/** Small UI-only preferences kept on this device (localStorage). Shared by the phone and the desktop UI. */
export interface Prefs {
  vizQuality: 'auto' | 'eco' | 'normal' | 'high';
  /** interface layout ("razmetka"): shapes, fonts and the philosophy of the UI; the colour theme is applied on top */
  layout: 'default' | 'nothing' | 'apple';
  lang: 'ru' | 'en';
  /** 3D visualizer scene that is always used first: -1 = random */
  vizScene: number;
  /** change the 3D scene with a tap / click (and keep it otherwise) */
  vizTap: boolean;
  /** album pages show the songs of the album that are not on this device */
  hints: boolean;
  /** "Scan": ignore audio files shorter than this many seconds */
  scanMin: number;
  /** song lists: mention the album of every song (desktop: "Album" column, phone: "artist · album") */
  listAlbum: boolean;
  /** 3D visualizer: sensitivity to the music, 0.5 (calm) … 2.5 (very lively); replaces the old vizGain (1 … 1.5) */
  vizSens: number;
  /** generated covers: 2D artwork, or a still frame of the chosen 3D-visualizer scene */
  coverStyle: 'classic' | 'viz';
  /** developer mode (Settings → tap the version 7 times): statistics viewer and reset */
  dev: boolean;
  /** desktop: take the YouTube sign-in from this browser for downloads ('' = none) */
  ytBrowser: string;
  /** phone: MP3 bitrate of downloads (kbps); 0 = the original stream without re-encoding (M4A / MP3, fast) */
  dlKbps: number;
  /** where songs are searched and downloaded from (search → internet, album hints, Spotify links) */
  dlSrc: 'all' | 'youtube' | 'soundcloud' | 'vk';
  /** 1.8.4: downloads switched to "Original" (no re-encoding) once */
  dlMig?: number;
}
const KEY = 'teto.prefs.v1';
const defaults: Prefs = { vizQuality: 'auto', layout: 'default', lang: 'ru', vizScene: -1, vizTap: true, hints: false, scanMin: 60, listAlbum: !isMobile, vizSens: 1.4, coverStyle: 'classic', dev: false, ytBrowser: '', dlKbps: 0, dlSrc: 'all' };
let cur: Prefs = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    // 1.8.3: "vizGain" (1 … 1.5) became "vizSens" (0.5 … 2.5) with a livelier default; a strong old setting is kept
    if (raw.vizSens == null && typeof raw.vizGain === 'number' && raw.vizGain > defaults.vizSens) raw.vizSens = raw.vizGain;
    delete raw.vizGain;
    // 1.8.4: phone downloads default to the original stream (fast); the old default 320 kbps MP3 switches once
    if (!raw.dlMig) { if (raw.dlKbps === 320) raw.dlKbps = 0; raw.dlMig = 1; }
    delete raw.dlPrefer; // 1.9: replaced by dlSrc
    return { ...defaults, ...raw };
  } catch { return { ...defaults }; }
})();
const subs = new Set<() => void>();
export const prefs = () => cur;
export function setPrefs(p: Partial<Prefs>) {
  cur = { ...cur, ...p };
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* ignore */ }
  subs.forEach((f) => f());
}
export const subscribePrefs = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** On battery (or on a phone) "auto" picks the economical renderer. */
let onBattery = isMobile;
let plugged = !isMobile; // desktops are assumed plugged in until the Battery API says otherwise
/** True when the device is charging (or is a desktop without a battery). */
export const isCharging = () => plugged;
(navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean; addEventListener: (e: string, f: () => void) => void }> })
  .getBattery?.().then((b) => { const f = () => { plugged = b.charging; onBattery = isMobile || !b.charging; }; f(); b.addEventListener('chargingchange', f); }).catch(() => {});
export function vizQuality(): 'eco' | 'normal' | 'high' {
  const q = cur.vizQuality;
  if (q !== 'auto') return q;
  return onBattery ? 'eco' : 'normal';
}
