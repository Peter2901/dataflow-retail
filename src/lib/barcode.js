// Store's own barcodes for items that come without one (loose, own-packed).
// They start with "02": GS1 keeps 020–029 for numbers used only inside one company,
// so they never clash with a brand's barcode, and they are different from weighing-scale
// stickers (which start with 20–29).
import { eanCheckDigit } from './util.js';

export const isStoreBarcode = c => /^02\d{11}$/.test(String(c || ''));

export function newStoreBarcode(taken = new Set()) {
  for (let i = 0; i < 200; i++) {
    const body = '02' + String(Date.now() + i).slice(-7) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const code = body + eanCheckDigit(body);
    if (!taken.has(code)) { taken.add(code); return code; }
  }
  throw new Error('Could not make a new barcode. Try again.');
}

// Picks the right symbology for printing.
export const barcodeFormat = c => (/^\d{13}$/.test(c) ? 'EAN13' : /^\d{8}$/.test(c) ? 'EAN8' : 'CODE128');
