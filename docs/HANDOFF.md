# DataFlow Retail — Handoff (24 Oct 2026)

Paste this into a new Claude chat first, then let Claude clone the repo (or attach a source zip of `main`).

## 1. What it is
Offline-first supermarket billing + stock + GST + accounts + CRM app for **Sameer's 4-counter store in Odisha**
(to be sold to other stores later).
- **Counter app** (Windows via Electron + web): billing and everything else.
- **Phone app** (Android via Capacitor): the whole store app except billing; connects with a setup code / QR.
- **Owner view**: light read-only build.
- English, Hindi, Odia. Multi-counter sync through Supabase. Golden rule: **code first, AI only as fallback**.

## 2. Links
| What | Link |
|---|---|
| Live website (counter app) | https://peter2901.github.io/dataflow-retail/ |
| Code | https://github.com/Peter2901/dataflow-retail (branch `main`) |
| Windows installer | GitHub › Releases (built by `windows.yml` on a `vX.Y.Z` tag) |
| Android APK | https://github.com/Peter2901/dataflow-retail/releases/download/owner-app/DataFlow-Owner.apk |
| Builds | https://github.com/Peter2901/dataflow-retail/actions (push to `main` runs website, Windows, Android) |

## 3. Tech
React 18, Vite 5, Dexie 4 (IndexedDB, database version 6), Electron 33, Capacitor 6, tesseract.js, jsbarcode,
qrcode, jsqr, xlsx. Supabase REST table `records` (+ row-level security per shop key) and Edge Function `dataflow-ai`.

## 4. Built (as of 24 Oct 2026)
Billing (GST 2.0 slabs 0/5/18/40, tax-inclusive, Rule 46 numbers, one-transaction save), batches/FEFO/expiry,
3 units per product (Bag/Kg/Gram, Case/Piece) with retail and wholesale prices per unit, Retail/Wholesale switch
and customer rate level, udhaar, staff, reports, accounts, multi-counter sync, Smart Scan purchase bills,
smart insights, Ask your shop, phone app, Smart & AI hub, Hindi/Odia screens, new look (light/dark),
Store & owner details, payment tiles F9–F12.

New on 23–24 Oct:
- **GST Saathi next level**: GST health (AATO, e-invoice, HSN digits, GSTR-9/9C, QRMP, composition limits),
  late fee + interest, GSTR-3B set-off by law (Rule 88A) with credit carried forward, Rule 37 (180-day) reversal
  and re-claim, 30 Nov deadline (s.16(4)), IMS action list + suppliers to call, GSTR-1A warning after filing,
  composition (CMP-08 / GSTR-4, bills of supply), year summary (GSTR-9) and a one-file CA pack.
  Rule book `public/gst-rules.json` v2026.10.2.
- **Backups**: streaming gzip `.dfrbak`, optional password (AES-GCM), restore checks the whole file first,
  no cloud/AI keys inside; Windows app keeps 14 daily backups.
- **Shop key**: many shops on one Supabase project, each sees only its own rows (rerun `supabase/setup.sql`).
- **Android release signing** from 4 GitHub secrets (see README › Android signing for selling).
- **Huge-data speed** (tested with 2.5 lakh bills, 10 lakh stock moves, 25,000 products, 30,000 customers):
  see README › Tested with huge data and `tools/stress/`.
- Sameer's item sheet: imports directly (billing-software layout, `src/lib/marg.js`; purchase rates that include
  GST are detected and converted) or via the converted file `Sameer_Products_Ready_to_Import_v2.xlsx`.
- Type-to-find product picker (purchase bills, offers, orders, stock adjust).

## 5. File map (main ones)
| Area | Files |
|---|---|
| Data + sync | `src/db.js`, `src/lib/sync.js`, `src/lib/sales.js`, `src/lib/daysums.js`, `src/lib/backup.js` |
| Billing | `src/pages/POS.jsx`, `src/lib/billing.js`, `src/lib/units.js` (units + price lists), `src/ui/Receipt.jsx`, `src/lib/offers.js` |
| Products | `src/pages/Products.jsx`, `src/lib/products.js`, `src/ui/ProductPicker.jsx`, `src/lib/search.js`, `src/lib/excel.js`, `src/lib/marg.js` |
| GST | `src/pages/GstSaathi.jsx`, `src/lib/gst.js`, `public/gst-rules.json` |
| Setup | `src/pages/Setup.jsx` (import, backup & restore), `src/pages/Settings.jsx` (cloud sync, shop key) |
| Phone signing | `scripts/android-signing.cjs`, `.github/workflows/android.yml` |
| Stress tools | `tools/stress/gen.js` (huge data), `tools/stress/mock-supabase.mjs` (shop-key cloud stand-in) |

## 6. Not verified yet
- Real Supabase project (run the latest `supabase/setup.sql` once), real Android phone, real thermal/label printer.
- Real AI calls (keys only in Supabase secrets — never in code or chat).
- Hindi/Odia wording — Sameer to review `scripts/translations.tsv`.
- GST Saathi rules and numbers — a CA should check one real month before real filing.
- The Windows/Android builds run in GitHub Actions; check the Actions page after each push.

## 7. Next steps
1. Add the 4 Android signing secrets (README) before giving the phone app to any paying store.
2. Run the latest setup SQL in Supabase; give every new shop its own shop key (or its own project).
3. Test at Sameer's store with real devices; load his item list; check the HSN codes the import flags.
4. CA review of GST Saathi; Sameer reviews Hindi/Odia.
