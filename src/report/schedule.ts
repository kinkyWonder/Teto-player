/**
 * When the monthly report can be opened: from the last day of a month (00:00) through the 3rd of the next month
 * (23:59) — always the report of that one month. The numbers only ever cover that month, and once the month is
 * over the report is frozen (saved), so it is exactly the same on the 1st, 2nd and 3rd as at 23:59 on the last day.
 * Meanwhile the Home screen shows a banner. Developer mode may open any month (archive / a peek at this month).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { buildReport, firstDay, monthKey, monthName, prevMonth, type Report } from './data';
import { prefs } from '../core/prefs';

const SNAP = 'teto.report.snap.v2';
const SEEN = 'teto.report.seen.v1';
const seen = (): string[] => { try { return JSON.parse(localStorage.getItem(SEEN) || '[]'); } catch { return []; } };
const markSeen = (m: string) => { const s = seen(); if (!s.includes(m)) { s.push(m); localStorage.setItem(SEEN, JSON.stringify(s.slice(-36))); } };
export const wasSeen = (m: string) => seen().includes(m);

let open: Report | null = null;
const subs = new Set<() => void>();
const set = (r: Report | null) => { open = r; subs.forEach((f) => f()); };
export const useReport = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => open);
export const closeReport = () => set(null);

/** The report window that is open now: the month it is about and until when it can be opened. */
export function reportWindow(now = new Date()): { month: string; until: Date } | null {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const last = new Date(y, m + 1, 0).getDate();
  if (d === last) return { month: monthKey(now), until: new Date(y, m + 1, 3, 23, 59, 59) };
  if (d <= 3) return { month: prevMonth(now), until: new Date(y, m, 3, 23, 59, 59) };
  return null;
}
/** When the next window opens (the last day of this month, 00:00). */
export const nextWindow = (now = new Date()) => new Date(now.getFullYear(), now.getMonth() + 1, 0);

/** A finished month: build once, keep (per language — the texts are built in the interface language). */
async function frozen(m: string): Promise<Report | null> {
  const lang = prefs().lang;
  let all: Record<string, Report> = {};
  try { all = JSON.parse(localStorage.getItem(SNAP) || '{}'); } catch { /* corrupted */ }
  const k = `${m}:${lang}`;
  if (all[k]) return all[k];
  const r = await buildReport(m);
  if (r) {
    all[k] = r;
    const keys = Object.keys(all).sort().slice(-6); // the last few months are enough
    try { localStorage.setItem(SNAP, JSON.stringify(Object.fromEntries(keys.map((x) => [x, all[x]])))); } catch { /* full */ }
  }
  return r;
}

/** Opens a month's report; false when there is nothing to show. Outside the window only developer mode may open it. */
export async function showReport(m: string, dev = false): Promise<boolean> {
  const w = reportWindow();
  if (!dev && w?.month !== m) return false;
  const over = m < monthKey(new Date());
  const r = over ? await frozen(m) : await buildReport(m); // the last day itself: live numbers up to this moment
  if (!dev) markSeen(m);
  if (r) set(r);
  return !!r;
}

/* the banner on Home: re-checked every minute (the window opens / closes at midnight) */
let tick = 0;
const tsubs = new Set<() => void>();
let started = false;
export function startReports() {
  if (started) return;
  started = true;
  setInterval(() => { if (!document.hidden) { tick++; tsubs.forEach((f) => f()); } }, 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick++; tsubs.forEach((f) => f()); } });
}
const useTick = () => useSyncExternalStore((f) => { tsubs.add(f); return () => { tsubs.delete(f); }; }, () => tick);

const HAS: Record<string, boolean> = {};
/** The open window with "is there anything to show" (≥ 5 minutes of music in that month). */
export function useReportWindow(): { month: string; label: string; until: Date; seen: boolean } | null {
  useTick();
  const w = reportWindow();
  const [, setV] = useState(0);
  useEffect(() => {
    if (!w || w.month in HAS) return;
    let live = true;
    (w.month < monthKey(new Date()) ? frozen(w.month) : buildReport(w.month)).then((r) => { HAS[w.month] = !!r; if (live) setV((x) => x + 1); }).catch(() => {});
    return () => { live = false; };
  }, [w?.month]);
  if (!w || !HAS[w.month]) return null;
  return { month: w.month, label: monthName(w.month), until: w.until, seen: wasSeen(w.month) };
}

/** Months with statistics, newest first (developer mode → archive). */
export async function reportMonths(): Promise<string[]> {
  const f = await firstDay();
  if (!f) return [];
  const out: string[] = [];
  const now = new Date();
  for (let d = new Date(now.getFullYear(), now.getMonth() - 1, 1); monthKey(d) >= f.slice(0, 7) && out.length < 24; d.setMonth(d.getMonth() - 1)) out.push(monthKey(d));
  return out;
}
