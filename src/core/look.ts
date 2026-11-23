/** Theme + layout ("razmetka") -> <html> attributes. */
import THEMES from '../styles/themes.json';
import { prefs } from './prefs';

type ThemeDef = { name: string; bg: string; s1: string; s2: string; acc: string; acc2: string; t1: string; light?: boolean };
export const THEME_LIST = THEMES as Record<string, ThemeDef>;
/** Themes removed in 1.6 fall back to Tide. */
export const themeKey = (k: string) => (k && k in THEME_LIST ? k : 'tide');
export const isLightTheme = (k: string) => !!THEME_LIST[themeKey(k)]?.light;

export const LAYOUTS = [['default', 'Default'], ['nothing', 'Nothing'], ['apple', 'Apple']] as const;
/** Each layout has a theme that suits it best (offered, never forced). */
export const LAYOUT_THEME: Record<string, string> = { default: 'tide', nothing: 'nothing', apple: 'apple' };

export function applyLayout() {
  document.documentElement.dataset.layout = prefs().layout || 'default';
  document.documentElement.lang = prefs().lang === 'en' ? 'en' : 'ru';
}
