import { createRoot } from 'react-dom/client';
import { isMobile, isNativeMobile, isTauri } from './app/platform';
import * as store from './app/store';
import './styles/themes.css';
import './styles/base.css';
import './styles/layouts.css';
import { applyLayout } from './core/look';

applyLayout(); // before the first paint: no flash of the default layout

if (!isTauri && !isNativeMobile) {
  // browser preview only: hooks for screenshots / debugging
  (window as unknown as { __tide: typeof store }).__tide = store;
  import('./report/schedule').then((m) => { (window as unknown as { __report: typeof m.showReport }).__report = m.showReport; });
}
const root = createRoot(document.getElementById('root')!);
if (isMobile || new URLSearchParams(location.search).has('mobile')) {
  import('./styles/mobile.css');
  import('./mobile/MobileApp').then(({ MobileApp }) => root.render(<MobileApp />));
} else import('./app/App').then(({ App }) => root.render(<App />));
