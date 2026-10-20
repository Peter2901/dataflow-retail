import React from 'react';
import { createRoot } from 'react-dom/client';
import OwnerApp from './OwnerApp.jsx';
import './owner.css';

createRoot(document.getElementById('root')).render(<OwnerApp />);

// Installable from Chrome on Android (not needed inside the APK).
if ('serviceWorker' in navigator && !window.Capacitor && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
