# DataFlow Retail

Supermarket billing, stock, expiry, GST, accounts, customers and staff in one browser app.
It keeps working when the internet is down, because every counter keeps its own copy of the data.

## Try it

```
npm install
npm run dev
```

Open http://localhost:5173. Demo PINs: Owner 1111 · Manager 2222 · Cashier 3333 · Accountant 4444.
The app starts with sample products and bills. Settings › Look & data › "Start fresh" clears them.

## Put it on the store's counter PC

1. `npm run build` makes a `dist` folder (plain HTML/JS, no server code).
2. Host `dist` on any HTTPS static host (Netlify, Cloudflare Pages, Vercel — free plans are fine),
   or run it on the PC with `npm start` (http://localhost:8080).
3. Open it in **Chrome** on the counter PC and choose *Install app*. After the first load it opens
   and bills even with no internet.
4. Set the store details, GSTIN, UPI ID and counter code in Settings. Give each counter its own code (T1, T2…).
5. Change the demo PINs in Settings › Users.
6. Load the real product list in Import & setup (works with the 'Sameer Excel Final 15OCT.xlsx' columns).
   The data checker blocks wrong GST rates (12% and 28% no longer exist), prices above MRP, bad barcodes
   and duplicates before anything is saved.

**Important:** data lives in that PC's Chrome. Take a backup every day (Import & setup › Backup & sync)
and never clear Chrome's site data on the counter PC.

## Hardware

- Barcode scanner (USB): works out of the box — it types like a keyboard.
- Thermal receipt printer (80 mm): set as default printer. Start Chrome with `--kiosk-printing` to skip the print dialog.
- Weighing scale (RS-232/USB): Import & setup › Counter hardware › Read weight (Chrome Web Serial). Scale-printed
  barcodes starting 20–29 are read automatically.
- Cash drawer: opens from the receipt printer's kick port.

## What's inside

| Area | Where in the code |
|---|---|
| GST maths (inclusive prices, CGST/SGST/IGST, rounding, Rule 46 bill numbers) | `src/lib/billing.js` |
| Batches, FEFO, expiry plan (90/60/30/7 days) | `src/lib/stock.js` |
| Offers + margin guard | `src/lib/offers.js` |
| Double-entry accounts, P&L, balance sheet, Tally XML | `src/lib/accounts.js` |
| Saving bills, loyalty, tamper-proof bill chain, audit log | `src/lib/sales.js` |
| Purchases, debit notes, reorder suggestions | `src/lib/purchasing.js` |
| Excel import and data checker | `src/lib/excel.js` |
| Screens | `src/pages/*.jsx` |
| Sample data | `src/seed.js` |

## Cloud sync (several counters)

Free, using a Supabase project. Each counter keeps its own full copy (billing never waits for the internet)
and every 8 seconds sends its new rows to one shared `records` table and pulls the other counters' rows.

- Setup: Settings › Cloud sync shows the one-time SQL. Paste it in Supabase › SQL Editor and run it.
- Every counter: same Project URL and publishable/anon key, **different counter code** (Settings › Store & GST: T1, T2…).
- Counter 1 presses *Send this counter's data to cloud* once. Counters 2–4 first use Settings › Look & data › *Start fresh*,
  then turn sync on — they download everything.
- Stock is synced as stock-move events, so two counters selling the same item at once never overwrite each other.
- Counters pull by the server's row number, not by their own clocks, so a counter that was offline for hours still
  delivers every bill when it reconnects.
- Edits sync from any counter (e.g. a customer created on T1 earns points on T2 → T1 sees the new points).
- Known limit (test version): if two counters change the same customer or product within the same few seconds,
  the last change wins.
- Built for big stores: only changed rows are read (an `updatedAt` index on every synced table), rows are sent a page
  at a time, and each received page is saved in one step. A stock-move clash that stopped the sync once two counters
  both billed is fixed (Oct 2026).
- **Many shops on one Supabase project (for reselling):** give each shop a **shop key** (Settings › Cloud sync ›
  Shop key). Rows are saved with that key and row-level security shows each shop only its own rows (run the latest
  setup SQL once). Every device of a shop needs the same key; the phone setup code carries it. A shop with its own
  Supabase project needs no key. Treat the key like a password.
- Code: `src/lib/sync.js`.

## Purchase bills: Smart Scan, checks and barcodes

**Smart Scan** (Purchases › New purchase bill › *Smart Scan bill photo*) reads a supplier bill photo, cheapest way first:

1. **E-invoice QR** on the bill (if any): supplier GSTIN, bill number, date and total, exactly.
2. **Free reading on the device** (offline OCR, `src/lib/billreader.js`; the desktop app runs it in `electron/main.cjs`).
   It is accepted only if the lines add up to the printed total and 90% of items are recognised.
3. **AI** only if the free reading is not sure, through the store's own Supabase function
   `supabase/functions/dataflow-ai` (Grok by default; switch company with the `AI_PROVIDER` secret). Settings › Smart Scan
   turns it off / on and shows how many bills were read free vs by AI this month.

The person always checks the screen (green = sure, yellow = check, red = pick) before saving.
**Supplier memory** (`itemAliases`, synced): what each supplier calls an item, and pieces per case, learned from every saved bill.

**Free checks on every bill** (`src/lib/purchaseChecks.js`): lines vs printed total, GST type vs supplier state (IGST vs
CGST+SGST), duplicate bill, cost per piece up since last time (after discounts and free goods), missing scheme, short expiry
measured against sales speed, cheaper supplier in the last 90 days, new MRP, selling at a loss.

Also: **scan-to-receive** (scan each item as goods are unpacked), **repeat last bill**, **quick add** (5 fields; also from
the counter when a barcode is unknown), **store barcodes** starting `02` for items without one, and **stickers**:
50×25 mm label printer, A4 sheets (65 or 40 per page, start at any position) and shelf labels.

## Phone app (Android) — the whole store except billing

The Android app is the full store app built with `npm run build:mobile` (`--mode mobile`), without the billing counter:
dashboard, Smart insights, products, stock, expiry, purchases with Smart Scan (bill photo from the phone camera),
customers, udhaar, accounts, reports, staff, Ask your shop and settings. It is a synced device like a counter
(code `P…`), so changes on the phone reach the counters within seconds; it sends no heartbeat (it is not a counter).

- APK (fixed link, rebuilt on every push): https://github.com/Peter2901/dataflow-retail/releases/download/owner-app/DataFlow-Owner.apk
- Connect: main counter (T1) › Settings › Cloud sync › *Phone app* → Share on WhatsApp / QR. Opening that card on T1 once
  shares users (hashed PINs), staff, shifts, audit log, history and store settings for phones (`prepareForPhones`).
- Store settings travel as one `storeSettings` row, sent only when a person saves a shared setting — a new or "start fresh"
  device can never overwrite the real store's settings. Device settings (sync keys, counter code, theme) never travel.
- The light owner view (`owner.html`, read-only) is still on the website.
- Signing: `android-signing/debug.keystore` (test key in a public repo — move it to a private secret before wider release).

## Smart features (code first, AI only when needed)

Plain code on the device does the work; the AI function `supabase/functions/dataflow-ai` (one function, tasks `bill`,
`pack`, `khata`, `voice`, `hsn`, `route`) is called only when the code cannot tell, and only if Settings › AI & Smart Scan
has AI on. Model/company switch with the `AI_PROVIDER` / `AI_MODEL` secrets; the key stays in Supabase.

| Feature | Code (free) | AI only when |
|---|---|---|
| Smart Scan bill photo | QR, offline OCR, parser, total checks | totals don't match / items not recognised |
| Spoken or typed purchase line | number words (Hindi/Odia/English), units, ₹, synonyms | item or quantity not found |
| Pack photo → product | barcode, OCR for MRP / net qty / FSSAI | name not readable |
| HSN / GST hint | your most similar product; built-in HSN list | you press Ask AI |
| Paper khata photo → dues | OCR + line parser | fewer than 2 rows read, or you ask |
| Ask your shop | intent words (EN/Hinglish/Hindi/Odia) → fixed reports | question not understood (AI only picks the report) |
| Dead stock, expiry clearance, festival planning, staff alerts, customer habits, udhaar recovery, daily summary, to-do, weekly report | `src/lib/insights.js` | never |
| Smart search ("chini", "ଚିନି", typos) | `src/lib/search.js` | never |
| WhatsApp texts in English / Hindi / Odia | `src/lib/messages.js` | never |

## Backups

Import & setup › **Backup & restore**. The backup streams table by table into a small gzip file (`.dfrbak`), so it
works with lakhs of bills; it can be locked with a password (AES-GCM). Restore checks the whole file first and changes
nothing if it is damaged, cut short or the password is wrong; this device's own settings (counter code, cloud keys)
are kept. Cloud and AI keys are never written into a backup. The Windows app saves one every day in
Documents › DataFlow Retail Backups and keeps the last 14; other devices get a reminder after 3 days.

## Android signing for selling

The phone app is signed with a **private release key** when these four GitHub repository secrets exist
(Settings › Secrets and variables › Actions): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Without them the build still uses the public test key and says so.
Make the key once on your own PC (Java's `keytool`):

```
keytool -genkeypair -v -keystore dataflow-release.jks -alias dataflow -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 dataflow-release.jks > keystore.txt     (Windows: certutil -encode dataflow-release.jks keystore.txt)
```

Paste the contents of `keystore.txt` as `ANDROID_KEYSTORE_BASE64`. Keep the `.jks` file and passwords safe and
offline — without them you can never update the app. Phones with the old test-key app must uninstall it once.

## Tested with huge data

The app was tested (tools/stress) against a year of a busy 4-counter store: 25,000 products, 30,000 customers, 2,50,000 bills
(about 10 lakh stock moves), 6,000 purchase bills. See the October 2026 notes in the commit history for the timings.

## Not built yet (next phase)

- Sending WhatsApp messages automatically (today each message opens WhatsApp ready to send; the WhatsApp Business API would send in bulk).
- Automatic UPI/card confirmation from a payment gateway (cashier confirms today).
- E-invoice (IRN) and e-way bill generation through a GST Suvidha Provider.
- Fingerprint/face devices and electronic shelf labels.

GST and payroll rates are configurable; confirm them with your accountant.

## Simpler layout: Smart & AI hub

- **Smart & AI** (amber block in the menu, 5th bottom tab on phones) lists every smart tool as a card marked
  *Free* (plain code on the device) or *AI if needed* (free code first, AI only when the code is not sure).
- Setup screens (Import & setup, Security & audit, Settings) are folded under **Setup** in the menu.
- Code: `src/pages/Hub.jsx`, menu and bottom tabs in `src/App.jsx`.

## Three units per product

On a product, open **Units (optional)** and fill Unit 1 (biggest), Unit 2 and Unit 3 (smallest), for example
Bag → Kg → Gram with `1 Bag = 30 Kg` and `1 Kg = 1000 Gram`. Pick which unit stock, MRP, price and purchase rate are
kept in (Kg here). Everything inside the app stays in that one unit, so GST, stock and reports are unchanged.

- **Counter:** a unit box on each bill line (Bag / Kg / Gram). The bill prints what was sold, e.g. `550 Gram`.
- **Purchase bill:** "Buying in Bag / Kg / Gram" on the line; the rate and pieces-per-unit fill in by themselves.
- **Stock and Products:** show `1 Bag 29 Kg 450 Gram` next to the plain number.
- **Retail and wholesale prices:** on the product, retail has a price per Unit 1 and per Unit 2, and wholesale has a price
  per Unit 1, 2 and 3 (one wholesale price if the product has one unit). An empty box uses the automatic price
  (selling price × units). Prices cannot be above MRP, and wholesale cannot be below the purchase rate.
  At the counter, a **Retail / Wholesale** switch sits above the items. A cashier needs a manager PIN for Wholesale.
  The bill prints "Wholesale rate". Excel columns: `RETAIL_PRICE_UNIT_1/2`, `WHOLESALE_PRICE_UNIT_1/2/3`, `WHOLESALE_PRICE`.
- **Excel:** columns `UNIT_1`, `UNIT_2`, `UNIT_3`, `UNIT_1_TO_2`, `UNIT_2_TO_3`, `STOCK_UNIT` (template has an example).

## GST Saathi

Money & team › **GST Saathi** walks through the month in five steps: due dates (monthly or quarterly/QRMP,
state-wise 22nd/24th), checks before filing, the GSTR-1 file (JSON in the offline-tool format, plus Excel tables),
the GSTR-2B match (with IMS guidance) and the GSTR-3B summary including ITC given back on write-offs.

Added in October 2026:

- **GST health:** turnover last year (AATO) and this year, worked out from the bills (or typed by the owner), and
  what it means: 4 or 6-digit HSN, e-invoice above ₹5 crore, GSTR-9 compulsory above ₹2 crore (9C above ₹5 crore),
  QRMP allowed up to ₹5 crore, composition limit.
- **Late fee and interest** on overdue returns: ₹50/day (₹20 nil), capped by turnover (₹2,000 / ₹5,000 / ₹10,000;
  nil ₹500) and 18% a year on late cash tax — all from the rule book.
- **GSTR-3B set-off by law** (section 49A / Rule 88A): IGST credit first; CGST never pays SGST and the reverse.
  Unused credit is carried to next month (saved when 3B is marked filed; the owner can correct it from the portal).
- **Rule 37 (180 days):** supplier bills still unpaid 180 days after the bill date — the credit goes back in 4(B)(2);
  once paid, it is taken again in 4(A)(5) and shown in 4(D)(1). Supplier payments are used for this.
- **30 November deadline** (section 16(4)): last year's credit not yet seen in 2B is flagged before the last date.
- **IMS action list:** Accept / Pending / Check for every 2B row, and a list of suppliers to call (Excel).
- **After filing:** if bills for a filed month arrive later (a counter synced late), it asks for GSTR-1A before 3B.
- **Composition:** CMP-08 each quarter (1% of taxable sales, exempt goods left out) and GSTR-4 once a year; bills
  become “Bill of supply” with no GST.
- **Year summary** (for GSTR-9 / GSTR-4) and a **CA pack**: one Excel with registers, every GSTR-1 table, 3B with
  set-off and the 180-day list.
- Bills of every store and counter under the GSTIN are included, read by date (fast with lakhs of bills).

- It prepares and checks; the person or their CA files on the portal. AI is never used here, and it never sets a GST rate.
- Always look at the portal's preview after uploading the JSON. If the portal changes its format, only `gstr1Json()`
  in `src/lib/gst.js` needs a change.
- **Rule book:** `public/gst-rules.json` (served by GitHub Pages). The app checks it once a day; the owner approves any
  change. To add a due-date extension, edit that file (e.g. `"extensions": { "gstr3b:2026-09": "2026-10-25" }`),
  raise `version`, and push.
- Get a CA to check GST Saathi once against a real month before selling it to other stores.

## Languages (English / हिंदी / ଓଡ଼ିଆ)

- Each device picks its own screen language (login screen and bottom of the menu).
- The wording lives in `scripts/translations.tsv` (English, Hindi, Odia columns). Open it in Excel or Sheets, fix a
  phrase, save as tab-separated, then run `node scripts/build-i18n.mjs`. `{x}` marks a changing part (a number, a name).
- Item names, customer names, numbers, table cells and printed bills are never translated.
- **Bilingual bills:** fill *Name in Hindi / Odia* on a product (or a `LOCAL_NAME` column in the Excel import) and it
  prints under the English name on the receipt.
- The Hindi and Odia wording was written by Claude: have a native speaker check it once before wide use.

## New look (from the approved design)

- Colours, menu groups and payment tiles follow the design canvas "DataFlow Retail — new layout".
- **Light / dark switch** (sun / moon) sits next to EN / हि / ଓ at the bottom of the menu; each device keeps its own choice.
- **Billing counter keys:** F9 Cash · F10 UPI · F11 Card · F12 Udhaar · F7 hold · F8 recall · F6 return · F2 scan · F3 customer.
  (In a normal Chrome window F11 may switch full screen; the installed Windows app does not have that problem.)
- **Store & owner details** (menu, above Setup): store, owner, GSTIN, legal name, FSSAI, UPI, logo, bill footer. It prints on every bill.
- **Phone tabs:** Home · Stock · Buy · Money (GST Saathi) · AI.
