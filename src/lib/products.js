// Product checks and saving, shared by the Products screen, Quick add, the counter and purchase bills.
import { db } from '../db.js';
import { validEAN } from './util.js';
import { GST_SLABS } from './billing.js';
import { addBatch } from './stock.js';
import { audit } from './sales.js';
import { newStoreBarcode } from './barcode.js';

export const BLANK_PRODUCT = { id: '', barcode: '', name: '', localName: '', category: '', brand: '', uom: 'PCS', hsn: '', gst: 5, mrp: '', price: '', cost: '', casePack: 1, rack: '', reorderMin: 5, reorderMax: 30, vendorId: '', loose: false, plu: '', active: true, batchTracked: true };

export function productErrors(p, products) {
  const errs = [];
  if (!String(p.name || '').trim()) errs.push('Name is needed.');
  if (!(Number(p.price) > 0)) errs.push('Selling price is needed.');
  if (Number(p.mrp) > 0 && Number(p.price) > Number(p.mrp)) errs.push('Selling price cannot be above MRP.');
  if (p.cost !== '' && p.cost != null && Number(p.cost) > 0 && Number(p.cost) >= Number(p.price)) errs.push('Purchase rate should be below selling price.');
  // EAN/UPC numbers must pass the check digit; other codes (supplier item codes) just need to be sensible.
  if (p.barcode && /^\d{8}$|^\d{12,14}$/.test(p.barcode) && !validEAN(p.barcode)) errs.push('Barcode check digit is wrong.');
  else if (p.barcode && !/^[A-Z0-9-]{3,20}$/i.test(p.barcode)) errs.push('Barcode can only have letters, numbers and dashes.');
  if (!GST_SLABS.includes(Number(p.gst))) errs.push(`GST must be ${GST_SLABS.join(', ')}%.`);
  if (p.barcode && products.some(x => x.barcode === p.barcode && x.id !== p.id)) errs.push('Another product already has this barcode.');
  return [...new Set(errs)];
}

export function cleanProduct(p) {
  const rec = { ...p, name: String(p.name).trim(), gst: Number(p.gst), mrp: Number(p.mrp) || Number(p.price), price: Number(p.price), cost: Number(p.cost) || 0, casePack: Number(p.casePack) || 1, reorderMin: Number(p.reorderMin) || 0, reorderMax: Number(p.reorderMax) || 0 };
  if (!rec.id) rec.id = 'SKU' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
  return rec;
}

// A store barcode that no product uses yet.
export async function freshStoreBarcode() {
  const taken = new Set((await db.products.toArray()).map(p => p.barcode).filter(Boolean));
  return newStoreBarcode(taken);
}

/**
 * Quick add: name, MRP, selling price, GST, opening stock (+ optional barcode/cost).
 * Creates the product and, if stock is given, an opening batch.
 */
export async function quickAddProduct({ name, barcode, mrp, price, gst, stock, cost, category, hsn, brand, storeId, user }) {
  const products = await db.products.toArray();
  const p = cleanProduct({ ...BLANK_PRODUCT, name, barcode: barcode || await freshStoreBarcode(), mrp, price: price || mrp, gst, cost: cost || '', category: category || 'General', hsn: hsn || '', brand: brand || '', quickAdded: true });
  const errs = productErrors(p, products);
  if (errs.length) throw new Error(errs.join(' '));
  await db.products.put(p);
  if (Number(stock) > 0) await addBatch({ productId: p.id, storeId, qty: Number(stock), cost: p.cost || 0, ref: 'OPENING' });
  await audit('product_quick_add', { product: p.name, barcode: p.barcode, stock: Number(stock) || 0 }, user);
  return p;
}
