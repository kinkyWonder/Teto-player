import type { Track } from './types';
import { enPlural, isEn } from '../i18n';

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString(isEn() ? 'en-US' : 'ru-RU').replace(/\u00a0/g, ' ');
}

export function plural(n: number, one: string, few: string, many: string): string {
  if (isEn()) { const e = enPlural(n, one); if (e) return e; }
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function fmtFormat(t: Pick<Track, 'codec' | 'bits' | 'rate' | 'kbps' | 'lossless'>): string {
  if (t.lossless && t.bits) return `${t.codec} ${t.bits}/${fmtRate(t.rate)}`;
  if (t.lossless) return `${t.codec} ${fmtRate(t.rate)}`;
  return t.kbps ? `${t.codec} ${t.kbps}` : t.codec;
}

function fmtRate(r: number): string {
  const k = r / 1000;
  return Number.isInteger(k) ? String(k) : String(Math.floor(k)); // 44.1 -> 44 (как в макете)
}

export const isHiRes = (t: Pick<Track, 'bits' | 'rate' | 'lossless'>) => t.lossless && (t.bits > 16 || t.rate > 48000);

export function durMin(s: number): string {
  const m = Math.round(s / 60);
  const [mn, h] = isEn() ? ['min', 'h'] : ['мин', 'ч'];
  if (m < 60) return `${m} ${mn}`;
  return `${Math.floor(m / 60)} ${h} ${m % 60} ${mn}`;
}
