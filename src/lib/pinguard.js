// Wrong PINs: after 5 in a row this device waits 30 seconds (then 1, 2, 4 minutes), so nobody can try
// PIN after PIN until one works — at login or in the manager-approval box.
const K = 'dfr_pin_fail';
let mem = null;                                  // used when the browser blocks storage
const read = () => { if (mem) return mem; try { return JSON.parse(localStorage.getItem(K) || '{}') || {}; } catch { return {}; } };
const write = v => { mem = v; try { localStorage.setItem(K, JSON.stringify(v)); } catch { /* storage blocked: memory only */ } };

/** Milliseconds left before another PIN may be tried (0 = go ahead). */
export const pinWait = () => Math.max(0, (read().until || 0) - Date.now());

/** A wrong PIN. Returns { n, until } — n = wrong PINs in a row. */
export function pinFailed() {
  const n = (read().n || 0) + 1;
  const until = n % 5 === 0 ? Date.now() + 30000 * Math.min(8, 2 ** (n / 5 - 1)) : (read().until || 0);
  const v = { n, until };
  write(v);
  return v;
}

export const pinOk = () => write({ n: 0, until: 0 });

export const waitText = ms => `Too many wrong PINs. Try again in ${Math.ceil(ms / 1000)} seconds.`;
