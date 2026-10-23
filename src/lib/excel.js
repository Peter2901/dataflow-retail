// Excel import/export, plus the data checker that runs before anything is loaded.
import * as XLSX from 'xlsx';
import { download, validEAN, todayISO, r2, localISO } from './util.js';
import { GST_SLABS } from './billing.js';
import { cleanUnits, unitErrors, priceErrors, cleanPrices } from './units.js';

// Column names from 'Sameer Excel Final 15OCT.xlsx', plus common alternatives.
const MAP = {
  id: ['SKU_CODE', 'SKU', 'ITEM CODE', 'CODE'],
  barcode: ['BARCODE_EAN', 'BARCODE', 'EAN'],
  name: ['ITEM_NAME', 'ITEM NAME', 'PRODUCT', 'NAME', 'DESCRIPTION'],
  localName: ['LOCAL_NAME', 'LOCAL NAME', 'HINDI_NAME', 'HINDI NAME', 'ODIA_NAME', 'ODIA NAME'],
  category: ['CATEGORY'], subCategory: ['SUB_CATEGORY', 'SUBCATEGORY'], brand: ['BRAND', 'COMPANY', 'MANUFACTURER'],
  uom: ['UOM', 'UNIT'], packSize: ['PACK_SIZE', 'SIZE'], casePack: ['CASE_PACK_QTY', 'CASE PACK', 'CASE_QTY'],
  hsn: ['HSN_CODE', 'HSN'], gst: ['GST_RATE_PCT', 'GST', 'GST%', 'GST RATE', 'TAX%'],
  cost: ['PURCHASE_RATE', 'PURCHASE RATE', 'COST', 'P.RATE'], mrp: ['MRP'], price: ['SELLING_PRICE', 'SELLING PRICE', 'SALE RATE', 'RATE', 'PRICE'],
  openingStock: ['OPENING_STOCK', 'OPENING STOCK', 'STOCK', 'QTY'], reorderMin: ['MIN_REORDER', 'REORDER', 'MIN STOCK'], reorderMax: ['MAX_STOCK', 'MAX STOCK'],
  rack: ['RACK_LOCATION', 'RACK', 'LOCATION'], batchTracked: ['BATCH_TRACKED'], vendorId: ['VENDOR_ID', 'SUPPLIER', 'VENDOR'],
  unit1: ['UNIT_1', 'UNIT 1', 'UNIT1'], unit2: ['UNIT_2', 'UNIT 2', 'UNIT2'], unit3: ['UNIT_3', 'UNIT 3', 'UNIT3'],
  c12: ['UNIT_1_TO_2', 'UNIT 1 TO 2', 'UNIT1_TO_UNIT2', 'CONV_1_TO_2'], c23: ['UNIT_2_TO_3', 'UNIT 2 TO 3', 'UNIT2_TO_UNIT3', 'CONV_2_TO_3'], stockUnit: ['STOCK_UNIT', 'STOCK UNIT', 'BASE_UNIT'],
  r1: ['RETAIL_PRICE_UNIT_1', 'RETAIL_UNIT_1'], r2: ['RETAIL_PRICE_UNIT_2', 'RETAIL_UNIT_2'],
  w1: ['WHOLESALE_PRICE_UNIT_1', 'WHOLESALE_UNIT_1'], w2: ['WHOLESALE_PRICE_UNIT_2', 'WHOLESALE_UNIT_2'], w3: ['WHOLESALE_PRICE_UNIT_3', 'WHOLESALE_UNIT_3'], wholesale: ['WHOLESALE_PRICE', 'WHOLESALE PRICE', 'WHOLESALE'],
  batchNo: ['BATCH_NO', 'BATCH'], expiry: ['EXPIRY_DATE', 'EXPIRY', 'EXP DATE', 'EXP'], plu: ['PLU'],
};

const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

function excelDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null; }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  const d = new Date(s);
  return isNaN(d) ? null : localISO(d);
}

export async function readSheet(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return { sheet: wb.SheetNames[0], rows: XLSX.utils.sheet_to_json(ws, { defval: '' }) };
}

export function mapProducts(raw) {
  if (!raw.length) return { mapped: [], columns: {} };
  const headers = Object.keys(raw[0]);
  const columns = {};
  for (const [k, alts] of Object.entries(MAP)) {
    const h = headers.find(h => alts.includes(norm(h)));
    if (h) columns[k] = h;
  }
  const mapped = raw.map((r, i) => {
    const g = k => (columns[k] ? r[columns[k]] : '');
    let uom = norm(g('uom')) || 'PCS';
    // 3 units: UNIT_1 (biggest), UNIT_2, UNIT_3, UNIT_1_TO_2, UNIT_2_TO_3. STOCK_UNIT = 1, 2, 3 or the unit's name (default: smallest, or the one above Gram/ML).
    let units;
    const names = [g('unit1'), g('unit2'), g('unit3')].map(x => String(x ?? '').trim());
    if (names[0] && names[1]) {
      const su = String(g('stockUnit') ?? '').trim();
      const byName = names.findIndex(n => n && n.toLowerCase() === su.toLowerCase());
      const base = su === '' ? undefined : byName >= 0 ? byName : Number(su) >= 1 && Number(su) <= 3 ? Number(su) - 1 : undefined;
      units = { names, c12: Number(g('c12')) || 0, c23: Number(g('c23')) || 0, base };
      const cu = cleanUnits({ uom, units });
      if (cu.units) { units = cu.units; uom = cu.uom; }
    }
    // Retail price for Unit 1 / Unit 2 and wholesale for Units 1-3 (only for products with units); one WHOLESALE_PRICE otherwise.
    const prices = units ? cleanPrices({ units, prices: { r: [g('r1'), g('r2')], w: [g('w1'), g('w2'), g('w3')] } }).prices : undefined;
    const wholesale = !units && Number(g('wholesale')) > 0 ? Number(g('wholesale')) : undefined;
    return {
      row: i + 2, id: String(g('id') || '').trim(), barcode: String(g('barcode') || '').replace(/\.0$/, '').trim(), name: String(g('name') || '').trim(), localName: String(g('localName') || '').trim(),
      category: String(g('category') || 'General').trim(), subCategory: String(g('subCategory') || '').trim(), brand: String(g('brand') || '').trim(),
      uom, packSize: g('packSize'), casePack: Number(g('casePack')) || 1, hsn: String(g('hsn') || '').replace(/\.0$/, '').trim(),
      gst: g('gst') === '' ? null : Number(String(g('gst')).replace('%', '')), cost: Number(g('cost')) || 0, mrp: Number(g('mrp')) || 0, price: Number(g('price')) || 0,
      openingStock: Number(g('openingStock')) || 0, reorderMin: Number(g('reorderMin')) || 0, reorderMax: Number(g('reorderMax')) || 0,
      rack: String(g('rack') || '').trim(), vendorId: String(g('vendorId') || '').trim(), batchNo: String(g('batchNo') || '').trim(),
      ...(units ? { units } : {}), ...(prices ? { prices } : {}), ...(wholesale ? { wholesale } : {}), expiry: excelDate(g('expiry')), plu: String(g('plu') || '').trim(), loose: ['KG', 'GM'].includes(uom) && !g('barcode'),
    };
  });
  return { mapped, columns };
}

// Data checker. Errors stop that row from loading; warnings load but are flagged.
export function checkProducts(items, existing = []) {
  const seenBar = {}, seenId = {};
  existing.forEach(p => { if (p.barcode) seenBar[p.barcode] = 'existing'; });
  const out = items.map(p => {
    const errors = [], warnings = [];
    if (!p.name) errors.push('Name missing');
    if (!(p.price > 0)) errors.push('Selling price missing');
    if (p.mrp && p.price > p.mrp) errors.push(`Selling price ₹${p.price} above MRP ₹${p.mrp}`);
    if (p.cost && p.price && p.cost >= p.price) errors.push(`Purchase rate ₹${p.cost} not below selling price ₹${p.price}`);
    if (p.gst == null || isNaN(p.gst)) errors.push('GST rate missing');
    else if (!GST_SLABS.includes(p.gst)) errors.push(p.gst === 12 || p.gst === 28 ? `GST ${p.gst}% no longer exists (since 22 Sep 2025) — set 5%, 18% or 40%` : `GST ${p.gst}% is not a valid slab`);
    if (p.barcode) {
      if (/^\d+$/.test(p.barcode) && [8, 12, 13, 14].includes(p.barcode.length) && !validEAN(p.barcode)) errors.push('Barcode check digit wrong');
      if (seenBar[p.barcode]) errors.push(seenBar[p.barcode] === 'existing' ? 'Barcode already used by a product in the system' : `Same barcode as row ${seenBar[p.barcode]}`);
      else seenBar[p.barcode] = p.row;
    } else if (!p.loose) warnings.push('No barcode — cashier must search by name');
    if (p.id) { if (seenId[p.id]) errors.push(`Same SKU as row ${seenId[p.id]}`); else seenId[p.id] = p.row; }
    if (!/^\d{4}$|^\d{6}$|^\d{8}$/.test(p.hsn)) warnings.push('HSN should be 4, 6 or 8 digits');
    const taxable = p.price / (1 + (p.gst || 0) / 100);
    const margin = taxable ? ((taxable - p.cost) / taxable) * 100 : 0;
    if (p.cost && margin < 5 && margin > 0) warnings.push(`Low margin ${margin.toFixed(1)}%`);
    if (p.cost && margin > 60) warnings.push(`Very high margin ${margin.toFixed(0)}% — check purchase rate`);
    if (p.expiry && p.expiry < todayISO() && p.openingStock > 0) warnings.push(`Expired on ${p.expiry} — will be quarantined, not sold`);
    if (p.openingStock < 0) errors.push('Opening stock below zero');
    unitErrors(p).forEach(e => errors.push(e));
    if (!errors.length) priceErrors(p).forEach(e => errors.push(e));
    if (!p.rack) warnings.push('No rack location');
    return { ...p, margin: r2(margin), errors, warnings };
  });
  return {
    rows: out,
    ok: out.filter(r => !r.errors.length).length,
    withErrors: out.filter(r => r.errors.length).length,
    withWarnings: out.filter(r => !r.errors.length && r.warnings.length).length,
    gstOld: out.filter(r => r.gst === 12 || r.gst === 28).length,
  };
}

export function exportRows(filename, sheetName, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  download(filename, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

/** Several sheets in one Excel file, e.g. the CA pack. sheets = [{ name, rows }] */
export function exportBook(filename, sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows && rows.length ? rows : [{ note: 'Nothing for this period' }]), String(name).slice(0, 31));
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  download(filename, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

export function exportProducts(products, stock = {}) {
  exportRows(`products-${todayISO()}.xlsx`, 'Products', products.map(p => ({
    SKU_CODE: p.id, BARCODE_EAN: p.barcode, ITEM_NAME: p.name, LOCAL_NAME: p.localName || '', CATEGORY: p.category, BRAND: p.brand, UOM: p.uom, CASE_PACK_QTY: p.casePack,
    HSN_CODE: p.hsn, GST_RATE_PCT: p.gst, PURCHASE_RATE: p.cost, MRP: p.mrp, SELLING_PRICE: p.price, STOCK: stock[p.id] || 0,
    UNIT_1: p.units?.names[0] || '', UNIT_2: p.units?.names[1] || '', UNIT_3: p.units?.names[2] || '', RETAIL_PRICE_UNIT_1: p.prices?.r?.[0] || '', RETAIL_PRICE_UNIT_2: p.prices?.r?.[1] || '', WHOLESALE_PRICE_UNIT_1: p.prices?.w?.[0] || '', WHOLESALE_PRICE_UNIT_2: p.prices?.w?.[1] || '', WHOLESALE_PRICE_UNIT_3: p.prices?.w?.[2] || '', WHOLESALE_PRICE: p.wholesale || '',
    UNIT_1_TO_2: p.units?.c12 || '', UNIT_2_TO_3: p.units?.c23 || '', STOCK_UNIT: p.units ? p.units.names[p.units.base] : '',
    MIN_REORDER: p.reorderMin, MAX_STOCK: p.reorderMax, RACK_LOCATION: p.rack, VENDOR_ID: p.vendorId, PLU: p.plu,
  })));
}

export function templateFile() {
  exportRows('product-import-template.xlsx', 'Products', [{
    SKU_CODE: 'SKU2001', BARCODE_EAN: '8901234567894', ITEM_NAME: 'Example Atta 5 kg', CATEGORY: 'Staples', SUB_CATEGORY: 'Atta', BRAND: 'Example', UOM: 'PCS', PACK_SIZE: 5,
    CASE_PACK_QTY: 4, HSN_CODE: '1101', GST_RATE_PCT: 5, PURCHASE_RATE: 228, MRP: 285, SELLING_PRICE: 259, OPENING_STOCK: 20, MIN_REORDER: 6, MAX_STOCK: 40,
    RACK_LOCATION: 'A1-R1-S1', BATCH_TRACKED: 'TRUE', VENDOR_ID: '', BATCH_NO: 'B123', EXPIRY_DATE: '2027-03-31',
  }, {
    // 3 units: 1 Bag = 30 Kg, 1 Kg = 1000 Gram. Price, rate and stock are per STOCK_UNIT (Kg here).
    SKU_CODE: 'SKU2002', ITEM_NAME: 'Example Toor Dal (loose)', CATEGORY: 'Pulses', BRAND: 'Example', UOM: 'KG', UNIT_1: 'Bag', UNIT_2: 'Kg', UNIT_3: 'Gram', UNIT_1_TO_2: 30, UNIT_2_TO_3: 1000, STOCK_UNIT: 'Kg',
    HSN_CODE: '0713', GST_RATE_PCT: 0, PURCHASE_RATE: 110, MRP: 150, SELLING_PRICE: 140, RETAIL_PRICE_UNIT_1: 4100, WHOLESALE_PRICE_UNIT_1: 3800, WHOLESALE_PRICE_UNIT_2: 128, WHOLESALE_PRICE_UNIT_3: 0.13, OPENING_STOCK: 60, MIN_REORDER: 30, MAX_STOCK: 150, RACK_LOCATION: 'A2-R1-S1',
  }]);
}

// Generic CSV reader for bank statements and GSTR-2B exports.
export async function readAny(file) {
  if (/\.json$/i.test(file.name)) return { json: JSON.parse(await file.text()) };
  return readSheet(file);
}
