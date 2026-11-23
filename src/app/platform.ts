/** Runtime platform flags (no imports here — safe to use from any module). */
type Cap = { isNativePlatform?: () => boolean; getPlatform?: () => string };
const cap = typeof window !== 'undefined' ? (window as unknown as { Capacitor?: Cap }).Capacitor : undefined;
/** running inside the Capacitor app (phone backend, native plugin) */
export const isNativeMobile = !!cap?.isNativePlatform?.();
/** browser preview of the phone UI (index.html?mobile) uses the phone UI with the mock backend */
const previewMobile = !isNativeMobile && typeof location !== 'undefined' && /[?&]mobile\b/.test(location.search) && !('__TAURI_INTERNALS__' in window);
/** phone UI */
export const isMobile = isNativeMobile || previewMobile;
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const isIOS = cap?.getPlatform?.() === 'ios';
