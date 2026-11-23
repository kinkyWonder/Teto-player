import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.teto.player',
  appName: 'Teto',
  webDir: 'dist',
  backgroundColor: '#0b0f12',
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: 'never',
    backgroundColor: '#0b0f12',
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SystemBars: { insetsHandling: 'css', style: 'DARK' },
  },
};

export default config;
