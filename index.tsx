import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { toast } from 'sonner';
import App from './App';
import ErrorBoundary from './src/components/ui/ErrorBoundary';
import './index.css';

const PRELOAD_RELOAD_STORAGE_KEY = 'transit_tag_preload_reload_at';
const PRELOAD_RELOAD_COOLDOWN_MS = 15_000;

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', event => {
    event.preventDefault();
    try {
      const now = Date.now();
      const lastReloadAt = Number(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY) || '0');
      if (now - lastReloadAt < PRELOAD_RELOAD_COOLDOWN_MS) {
        toast.error('アプリの更新読み込みに失敗しました。ページを再読み込みしてください。');
        return;
      }
      sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, String(now));
    } catch {
      // sessionStorage may be unavailable in restricted browsing contexts
    }
    window.location.reload();
  });
}

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    toast.info('アプリの新しいバージョンが利用可能です', {
      id: 'pwa-update-available',
      duration: Number.POSITIVE_INFINITY,
      description: 'タイミングの良いときに更新して再読み込みしてください。',
      action: {
        label: '更新して再読み込み',
        onClick: () => {
          void updateSW(true);
        },
      },
    });
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
