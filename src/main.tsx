import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);

// Register the lightweight app-shell cache only in production. Audio data and
// /api requests are excluded by the service worker and remain in their stores.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('Não foi possível ativar o modo de instalação/offline:', error);
    });
  }, { once: true });
}
