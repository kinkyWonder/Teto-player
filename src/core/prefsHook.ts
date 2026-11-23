import { useSyncExternalStore } from 'react';
import { prefs, subscribePrefs, type Prefs } from './prefs';
/** Re-render on preference changes (same as SettingsView's usePrefs, without importing the settings screen). */
export function usePrefsLite(): Prefs { return useSyncExternalStore(subscribePrefs, prefs); }
