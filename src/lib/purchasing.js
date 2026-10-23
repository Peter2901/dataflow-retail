// Buying: purchase bills (goods receipt), supplier returns with debit notes, and reorder suggestions.
import { db } from '../db.js';
import { uid, r2, sum, addDays, todayISO, localISO } from './util.js';
import { addBatch, moveStock, daysLeft, stockMap } from './stock.js';
import { postPurchase, postDebitNote, postPayment } from './accounts.js';
import { audit } from './sales.js';
import { lineCalc } from './purchaseChecks.js';
import { aliasId } from './match.js';

const nextNo = async (table, prefix) => prefix + String((await db[table].count()) + 1001);

/**
 * Saves a supplier bill. Lines: qty and free in the supplier's unit, pack = pieces per unit,
 * rate per unit before GST, disc = trade discount %. Stock goes in as pieces at the real
 * landing cost (after discount and free goods). Lines read from a bill also teach the
 * supplier memory: "what this supplier calls it" → product, and pieces per unit.
 */
export async function savePurchase({ supplier, billNo, date, lines, storeId, user, source = 'manual', poId = null, updateMrp = true, scan = null }) {
  const L = lines.filter(l => l.productId && Number(l.qty) > 0).map(l => {
    const c = lineCalc(l);
    return { productId: l.productId, name: l.name, text: l.text || '', hsn: l.hsn || '', unit: l.unit || '', qty: c.qty, free: c.free, pack: c.pack, rate: c.rate, disc: c.disc, gst: c.gst,
      mrp: Number(l.mrp) || null, batchNo: l.batchNo || '', expiry: l.expiry || '', mfg: l.mfg || '', taxable: c.taxable, tax: c.tax, pieces: c.pieces, landing: r2(c.landing) };
  });
  const taxable = r2(sum(L, l => l.taxable)), tax = r2(sum(L, l => l.tax));
  const no = await nextNo('purchases', 'PUR-');
  const pur = { id: uid('p_'), no, billNo, supplierId: supplier.id, date, storeId, lines: L, taxable, tax, total: r2(taxable + tax), paid: 0, source, poId, scan,
    dueDate: localISO(addDays(new Date(date), supplier.termsDays || 0)) };
  await db.purchases.add(pur);
  for (const l of L) {
    await addBatch({ productId: l.productId, storeId, batchNo: l.batchNo, mfg: l.mfg, expiry: l.expiry, qty: l.pieces, cost: l.landing, mrp: l.mrp, ref: no });
    // Purchase rate becomes the weighted average landing cost, so margins stay right.
    const p = await db.products.get(l.productId);
    if (p) {
      const onHand = (await stockMap(storeId))[p.id] || 0;
      const prev = Math.max(0, onHand - l.pieces);
      const avg = onHand > 0 ? r2((prev * (p.cost || l.landing) + l.pieces * l.landing) / onHand) : l.landing;
      const upd = { cost: avg, vendorId: p.vendorId || supplier.id };
      if (!p.hsn && l.hsn) upd.hsn = l.hsn;
      if (updateMrp && l.mrp && Math.abs(l.mrp - (p.mrp || 0)) >= 0.01) {
        upd.mrp = l.mrp;
        if (p.price >= (p.mrp || 0) || p.price > l.mrp) upd.price = l.mrp;   // sold at MRP before, or now above it
        await audit('price_change', { product: p.name, from: p.price, to: upd.price ?? p.price, mrpFrom: p.mrp, mrpTo: l.mrp, ref: no }, user);
      }
      await db.products.update(p.id, upd);
    }
    if (l.text) await db.itemAliases.put({ id: aliasId(supplier.id, l.text), supplierId: supplier.id, text: l.text, productId: l.productId, pack: l.pack, unit: l.unit });
  }
  if (poId) await db.purchaseOrders.update(poId, { status: 'received', purchaseId: pur.id });
  const settings = Object.fromEntries((await db.settings.toArray()).map(r => [r.key, r.value]));
  await postPurchase(pur, supplier, supplier.stateCode && supplier.stateCode !== settings.stateCode);
  await audit('purchase', { no, supplier: supplier.name, total: pur.total, source }, user);
  return pur;
}

/** The supplier's last bill, as fresh draft lines (no batch/expiry) — "repeat last bill". */
export async function lastBillLines(supplierId) {
  const last = (await db.purchases.where('supplierId').equals(supplierId).toArray()).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  if (!last) return null;
  return { bill: last, lines: last.lines.map(l => ({ productId: l.productId, name: l.name, text: l.text || '', unit: l.unit || '', hsn: l.hsn || '', qty: l.qty, free: l.free || 0, pack: l.pack || 1, rate: l.rate, disc: l.disc || 0, gst: l.gst, mrp: l.mrp || '' })) };
}

export async function createDebitNote({ supplier, items, reason, user }) {
  const settings = Object.fromEntries((await db.settings.toArray()).map(r => [r.key, r.value]));
  const L = [];
  for (const it of items) {
    const p = await db.products.get(it.batch.productId);
    const taxable = r2(it.qty * it.batch.cost);
    L.push({ productId: p.id, name: p.name, batchNo: it.batch.batchNo, expiry: it.batch.expiry, qty: it.qty, rate: it.batch.cost, gst: p.gst, taxable, tax: r2((taxable * p.gst) / 100) });
    await moveStock({ batchId: it.batch.id, productId: p.id, storeId: it.batch.storeId, qty: -it.qty, type: 'return_supplier', ref: reason });
    const b = await db.batches.get(it.batch.id);
    if (b && b.qty <= 0.0001) await db.batches.update(b.id, { status: 'returned' });
  }
  const taxable = r2(sum(L, l => l.taxable)), tax = r2(sum(L, l => l.tax));
  const dn = { id: uid('dn_'), no: await nextNo('debitNotes', 'DN-'), supplierId: supplier.id, date: todayISO(), lines: L, taxable, tax, total: r2(taxable + tax), reason, status: 'sent' };
  await db.debitNotes.add(dn);
  await postDebitNote(dn, supplier, supplier.stateCode && supplier.stateCode !== settings.stateCode);
  await audit('debit_note', { no: dn.no, supplier: supplier.name, total: dn.total }, user);
  return dn;
}

export async function paySupplier({ supplier, amount, mode, ref, user, purchaseIds = [] }) {
  let left = Number(amount);
  const open = (await db.purchases.where('supplierId').equals(supplier.id).toArray()).filter(p => p.total - (p.paid || 0) > 0.01)
    .sort((a, b) => (purchaseIds.includes(a.id) ? -1 : 0) - (purchaseIds.includes(b.id) ? -1 : 0) || a.date.localeCompare(b.date));
  for (const p of open) {
    if (left <= 0) break;
    const pay = Math.min(left, r2(p.total - (p.paid || 0)));
    await db.purchases.update(p.id, { paid: r2((p.paid || 0) + pay) });
    left = r2(left - pay);
  }
  await postPayment({ supplier, amount: Number(amount), mode, ref, ts: Date.now() });
  await audit('supplier_payment', { supplier: supplier.name, amount }, user);
}

/**
 * Reorder suggestions: reorder point from the last 30 days' sales speed and the supplier's lead time,
 * rounded up to full cartons. Items with stock close to expiry are skipped (the 90-day rule).
 */
export async function reorderSuggestions(storeId, cfg) {
  const products = (await db.products.toArray()).filter(p => p.active !== false);
  const stock = await stockMap(storeId);
  const since = Date.now() - 30 * 86400000;
  const sales = await db.sales.where('ts').above(since).filter(s => s.storeId === storeId && s.type === 'sale').toArray();
  const sold = {};
  sales.forEach(s => s.lines.forEach(l => (sold[l.productId] = (sold[l.productId] || 0) + l.qty)));
  const batches = (await db.batches.where('storeId').equals(storeId).toArray()).filter(b => b.status === 'active' && b.qty > 0);
  const suppliers = Object.fromEntries((await db.suppliers.toArray()).map(s => [s.id, s]));
  const openPO = new Set((await db.purchaseOrders.toArray()).filter(o => ['draft', 'sent'].includes(o.status)).flatMap(o => o.lines.map(l => l.productId)));
  const out = [];
  for (const p of products) {
    const onHand = stock[p.id] || 0;
    const daily = (sold[p.id] || 0) / 30;
    const lead = suppliers[p.vendorId]?.leadDays || 3;
    const safety = Math.ceil(daily * 2);
    const rop = Math.max(p.reorderMin || 0, Math.ceil(daily * lead + safety));
    if (onHand > rop) continue;
    const nearExpiry = batches.some(b => b.productId === p.id && b.expiry && daysLeft(b.expiry) <= (cfg?.stopReorderDays || 90) && daysLeft(b.expiry) >= 0 && b.qty >= Math.max(1, daily * 7));
    let qty = Math.max((p.reorderMax || rop * 2) - onHand, 1);
    const cp = p.casePack || 1;
    qty = Math.ceil(qty / cp) * cp;
    out.push({ id: p.id, product: p, onHand, daily: r2(daily), rop, qty, nearExpiry, hasOpenPO: openPO.has(p.id), supplierId: p.vendorId });
  }
  return out;
}

export async function createPO({ supplier, lines, user }) {
  const L = lines.map(l => ({ ...l, taxable: r2(l.qty * l.rate), tax: r2((l.qty * l.rate * l.gst) / 100) }));
  const po = { id: uid('po_'), no: await nextNo('purchaseOrders', 'PO-'), supplierId: supplier.id, date: todayISO(), lines: L, total: r2(sum(L, l => l.taxable + l.tax)), status: 'draft' };
  await db.purchaseOrders.add(po);
  await audit('po_created', { no: po.no, supplier: supplier.name, total: po.total }, user);
  return po;
}

export function poText(po, supplier, settings) {
  return `*Purchase order ${po.no}*\nFrom: ${settings.storeName}${settings.gstin ? ' (GSTIN ' + settings.gstin + ')' : ''}\nTo: ${supplier.name}\nDate: ${po.date}\n\n${po.lines.map((l, i) => `${i + 1}. ${l.name} — ${l.qty} units @ ₹${l.rate}`).join('\n')}\n\nTotal approx. ₹${po.total.toFixed(2)} incl. GST\nPlease confirm delivery date. Thank you.`;
}
