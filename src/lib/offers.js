// Offer engine: runs at the counter with no internet. Margin guard stops any offer
// from pushing a line below cost unless a manager approved it.
import { r2 } from './util.js';

const live = (o, now = Date.now()) =>
  o.active && (!o.from || new Date(o.from).getTime() <= now) && (!o.to || new Date(o.to).getTime() + 86399000 >= now);

/**
 * lines: [{ key, productId, category, qty, unitPrice, cost, markdownDisc }]
 * returns { perLine: {key: {disc, note, capped}}, billDiscounts: [{label, amount}] }
 */
export function applyOffers(lines, offers, { marginOverride = false } = {}) {
  const active = offers.filter(o => live(o));
  const perLine = {};
  lines.forEach(l => (perLine[l.key] = { disc: 0, notes: [] }));

  // Quantity of each product in the cart (a product can be on several lines).
  const qtyByProduct = {};
  lines.forEach(l => (qtyByProduct[l.productId] = (qtyByProduct[l.productId] || 0) + Number(l.qty)));

  for (const o of active) {
    if (o.type === 'qtySlab') {
      const q = qtyByProduct[o.productId] || 0;
      const slab = [...(o.slabs || [])].sort((a, b) => b.minQty - a.minQty).find(s => q >= s.minQty);
      if (slab) lines.filter(l => l.productId === o.productId).forEach(l => {
        const d = Math.max(0, (l.unitPrice - slab.price) * l.qty);
        if (d > 0) { perLine[l.key].disc += d; perLine[l.key].notes.push(`${o.name}: ₹${slab.price} each`); }
      });
    }
    if (o.type === 'bxgy') {
      const q = qtyByProduct[o.productId] || 0;
      const sets = Math.floor(q / (o.buy + o.get));
      const freeUnits = sets * o.get;
      if (freeUnits > 0) {
        const l = lines.find(x => x.productId === o.productId);
        const d = freeUnits * l.unitPrice * (o.pct / 100);
        perLine[l.key].disc += d; perLine[l.key].notes.push(o.name);
      }
    }
    if (o.type === 'category') {
      lines.filter(l => l.category === o.category).forEach(l => {
        const d = l.unitPrice * l.qty * (o.pct / 100);
        perLine[l.key].disc += d; perLine[l.key].notes.push(`${o.name} (${o.pct}% off)`);
      });
    }
    if (o.type === 'combo') {
      const ids = o.productIds || [];
      if (ids.length && ids.every(id => (qtyByProduct[id] || 0) >= 1)) {
        const times = Math.min(...ids.map(id => Math.floor(qtyByProduct[id])));
        const share = (o.off * times) / ids.length;
        ids.forEach(id => {
          const l = lines.find(x => x.productId === id);
          perLine[l.key].disc += share; perLine[l.key].notes.push(o.name);
        });
      }
    }
  }

  // Margin guard: never below cost (markdown on near-expiry stock is allowed — selling beats throwing away).
  for (const l of lines) {
    const pl = perLine[l.key];
    const floor = Math.max(0, (l.unitPrice - l.cost) * l.qty - (l.markdownDisc || 0));
    if (!marginOverride && l.cost > 0 && pl.disc > floor) {
      pl.disc = floor; pl.capped = true; pl.notes.push('Margin guard: limited to cost');
    }
    pl.disc = r2(pl.disc);
    pl.note = pl.notes.join(' · ');
  }

  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty - (l.markdownDisc || 0) - perLine[l.key].disc, 0);
  const billDiscounts = [];
  const buster = active.filter(o => o.type === 'billBuster' && subtotal >= o.minAmount).sort((a, b) => b.off - a.off)[0];
  if (buster) billDiscounts.push({ label: buster.name, amount: buster.off });
  return { perLine, billDiscounts };
}

export const OFFER_TYPES = {
  qtySlab: 'Buy more, pay less',
  bxgy: 'Buy X get Y',
  category: 'Category % off',
  combo: 'Combo deal',
  billBuster: 'Spend more, save more',
};
