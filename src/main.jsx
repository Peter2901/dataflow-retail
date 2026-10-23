import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

// Stress-test build only (removed from normal builds).
if (import.meta.env.MODE === 'stress') import('./dev/stressHooks.js').then(m => m.install());

// Offline start-up when installed on the store PC (not inside a claude.ai artifact preview).
if ('serviceWorker' in navigator && window.self === window.top && location.protocol.startsWith('http') && !import.meta.env.DEV) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
