// The counter's bill, worked out from the cart: batches (FEFO), units, retail/wholesale prices, offers,
// points and GST. Kept outside the screen so the same code is used by the counter and by the big tests.
import { computeBill } from './billing.js';
import { applyOffers } from './offers.js';
import { allocateFEFO } from './stock.js';
import { r2, sum, validGSTIN } from './util.js';
import { unitList, priceFor } from './units.js';

// Units: the cart keeps every quantity in the product's base unit; `unit` is only how the cashier sees it.
export function unitInfo(p, c) {
  const L = unitList(p);
  if (!L.length) return {};
  const cur = L[c.unit] || L.find(x => x.base);
  return { units: L, unitIdx: cur.i, unitName: cur.name, unitFactor: cur.factor };
}

// Batch allocation (FEFO) for every cart line (cart quantities are in the base unit). Lines whose
// quantity did not change keep their earlier result, so a 60-item bill does not re-read every batch per scan.
export async function allocateCart(cart, storeId, cfg, cache = new Map()) {
  const m = {};
  for (const c of cart) {
    const q = Number(c.qty) || 0;
    const hit = cache.get(c.key);
    if (hit && hit.forQty === q && hit.productId === c.productId) { m[c.key] = hit; continue; }
    const res = { ...(await allocateFEFO(c.productId, q, storeId, cfg)), forQty: q, productId: c.productId };
    cache.set(c.key, res);
    m[c.key] = res;
  }
  return m;
}

// Everything on screen (and what gets saved) is worked out here, from the cart and its allocations.
// composition: the store is a composition dealer — no GST on bills (the item's rate is kept as rateWas).
// Wholesale bills skip shop offers unless the owner turned them on (Settings › Loyalty & credit).
export function buildView({ cart, allocs, offers, pmap, customer, points, b2b, settings, priceMode }) {
  const composition = !!settings.gstFiling?.composition;
  const lines = cart.map(c => {
    const p = pmap[c.productId];
    if (!p) return null;
    const ui = unitInfo(p, c);
    const unitPrice = c.price ?? priceFor(p, ui.unitIdx, priceMode);
    const a = allocs[c.key] || { alloc: [], blocked: [] };
    const stale = !allocs[c.key] || allocs[c.key].forQty !== (Number(c.qty) || 0);
    const markdownDisc = r2(sum(a.alloc, x => (x.qty * unitPrice * x.markdown) / 100));
    return { key: c.key, productId: p.id, name: p.name, ...(p.localName ? { localName: p.localName } : {}), hsn: p.hsn, gst: composition ? 0 : p.gst, ...(composition ? { rateWas: p.gst } : {}), qty: Number(c.qty) || 0, unitPrice, mrp: p.mrp, cost: p.cost, uom: p.uom, category: p.category, markdownDisc, alloc: a, stale, override: c.price != null, ...ui };
  }).filter(Boolean);
  const noOffers = priceMode === 'wholesale' && !settings.wholesaleOffers;
  const o = applyOffers(lines, noOffers ? [] : offers, { marginOverride: lines.some(l => l.override) });
  const billLines = lines.map(l => ({
    ...l, lineDisc: r2(l.markdownDisc + (o.perLine[l.key]?.disc || 0)), batches: l.alloc.alloc,
    offerNote: [l.markdownDisc ? 'Near-expiry markdown' : '', o.perLine[l.key]?.note].filter(Boolean).join(' · '),
  }));
  const pre = computeBill(billLines, o.billDiscounts);
  const maxPts = customer ? Math.max(0, Math.min(customer.points || 0, Math.floor(pre.totals.payable * (settings.pointsMaxPct || 30) / 100))) : 0;
  const usePts = Math.min(points, maxPts);
  const bd = [...o.billDiscounts, ...(usePts ? [{ label: `Points (${usePts})`, amount: usePts }] : [])];
  const inter = !!(b2b && validGSTIN(b2b) && b2b.slice(0, 2) !== settings.stateCode);
  const bill = computeBill(billLines, bd, inter);
  return { lines, billLines, bill, maxPts, usePts, inter, stale: lines.some(l => l.stale), blocked: lines.filter(l => !l.stale && !l.alloc.alloc.length && l.alloc.blocked.length) };
}
