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
- Code: `src/lib/sync.js`.

## Purchase bills: Smart Scan, checks and barcodes

**Smart Scan** (Purchases › New purchase bill › *Smart Scan bill photo*) reads a supplier bill photo, cheapest way first:

1. **E-invoice QR** on the bill (if any): supplier GSTIN, bill number, date and total, exactly.
2. **Free reading on the device** (offline OCR, `src/lib/billreader.js`; the desktop app runs it in `electron/main.cjs`).
   It is accepted only if the lines add up to the printed total and 90% of items are recognised.
3. **AI** only if the free reading is not sure, through the store's own Supabase function
   `supabase/functions/read-bill` (Grok by default; switch company with the `AI_PROVIDER` secret). Settings › Smart Scan
   turns it off / on and shows how many bills were read free vs by AI this month.

The person always checks the screen (green = sure, yellow = check, red = pick) before saving.
**Supplier memory** (`itemAliases`, synced): what each supplier calls an item, and pieces per case, learned from every saved bill.

**Free checks on every bill** (`src/lib/purchaseChecks.js`): lines vs printed total, GST type vs supplier state (IGST vs
CGST+SGST), duplicate bill, cost per piece up since last time (after discounts and free goods), missing scheme, short expiry
measured against sales speed, cheaper supplier in the last 90 days, new MRP, selling at a loss.

Also: **scan-to-receive** (scan each item as goods are unpacked), **repeat last bill**, **quick add** (5 fields; also from
the counter when a barcode is unknown), **store barcodes** starting `02` for items without one, and **stickers**:
50×25 mm label printer, A4 sheets (65 or 40 per page, start at any position) and shelf labels.

## Owner phone app (Android)

View-only app for the owner: today's sales and profit, how customers paid, sales by hour, top items, every
counter's online/offline status, WhatsApp orders, expired/expiring/low stock, and today's bills. It reads two
summaries computed in Supabase (`owner_today`, `owner_alerts` in `supabase/setup.sql`), about 2 KB per refresh.

- APK (fixed link, rebuilt on every push): https://github.com/Peter2901/dataflow-retail/releases/download/owner-app/DataFlow-Owner.apk
- No-install version: https://peter2901.github.io/dataflow-retail/owner.html (Chrome › Install app)
- Setup: counter › Settings › Cloud sync › *Owner phone app* › Share on WhatsApp (or scan the QR).
- Code: `owner.html`, `src/owner/`. Android wrapper: Capacitor (`capacitor.config.json`, `.github/workflows/android.yml`).
- Signing: the APK is signed with `android-signing/debug.keystore` so updates install over the old app.
  This is a test key in a public repo — move it to a private GitHub secret before wider release.

## Not built yet (next phase)

- Sending WhatsApp messages automatically (today each message opens WhatsApp ready to send; the WhatsApp Business API would send in bulk).
- Automatic UPI/card confirmation from a payment gateway (cashier confirms today).
- E-invoice (IRN) and e-way bill generation through a GST Suvidha Provider.
- Fingerprint/face devices and electronic shelf labels.
- The AI assistant answers free-form questions inside claude.ai; the installed app has fixed quick answers until an AI key is added (`src/lib/ai.js`).

GST and payroll rates are configurable; confirm them with your accountant.
