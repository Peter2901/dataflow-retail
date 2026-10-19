// Store hardware from the browser.
// Barcode scanners act like a keyboard, so they work everywhere with no setup.
// Weighing scales use Chrome's Web Serial (store PC only; not inside the demo link).

let scalePort = null;

export const serialSupported = () => 'serial' in navigator;

export async function readScaleWeight() {
  if (!serialSupported()) throw new Error('This browser cannot talk to a scale. Use Chrome on the counter PC, or type the weight.');
  if (!scalePort) {
    scalePort = await navigator.serial.requestPort();
    await scalePort.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
  }
  const reader = scalePort.readable.getReader();
  let text = '';
  const deadline = Date.now() + 2500;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null, done: false }), 400))]);
      if (done) break;
      if (value) text += new TextDecoder().decode(value);
      const m = text.match(/(\d+\.\d{2,3})\s*(kg|KG)?/);
      if (m) return Number(m[1]);
    }
  } finally { reader.releaseLock(); }
  throw new Error('No steady weight from the scale. Check the cable and try again.');
}

// Short beep for errors at the counter (expired item, unknown barcode).
export function beep(ok = false) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220; o.type = 'square'; g.gain.value = 0.05;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.08 : 0.3));
  } catch { /* sound is optional */ }
}

export function printReceipt() {
  // Works in the installed app. Inside a claude.ai artifact the viewer blocks printing.
  if (window.dfrDesktop) return window.dfrDesktop.print();
  window.print();
}
