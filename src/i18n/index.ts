/** Interface language. Russian strings are the keys; English comes from ./i18n.en. */
import { prefs } from '../core/prefs';
import { EN, EN_PLURAL } from './en';

export const isEn = () => prefs().lang === 'en';

/** t('Добавлено в «{0}»', name) */
export function t(s: string, ...a: (string | number)[]): string {
  let r = isEn() ? EN[s] ?? s : s;
  for (let i = 0; i < a.length; i++) r = r.split(`{${i}}`).join(String(a[i]));
  return r;
}

/** English plural for a Russian "one" form (used by util.plural). */
export function enPlural(n: number, one: string): string | null {
  const p = EN_PLURAL[one];
  if (!p) return null;
  return Math.abs(n) === 1 ? p[0] : p[1];
}
