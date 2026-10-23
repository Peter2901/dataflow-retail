# Stress tests with huge data

Used in October 2026 (kept in tools/stress) to test the app with a year of a busy 4-counter store.

- `gen.js` — runs inside the page and writes straight into the app's IndexedDB:
  25,000 products (with batches), 30,000 customers, 300 suppliers, 6,000 purchase bills,
  2,50,000 bills over 395 days (about 10 lakh stock moves, 2.5 lakh journal entries and audit rows).
  Change the sizes with `window.__gen({ products, customers, suppliers, purchases, sales, days })`.
- `mock-supabase.mjs` — a small stand-in for Supabase's `records` table with the same per-shop
  row-level security as `supabase/setup.sql` (used to test the shop key: two shops on one cloud
  never see each other's rows). `node mock-supabase.mjs 54321`, then point Settings › Cloud sync at
  `http://localhost:54321`. `GET /__stats` shows rows per shop.

How to run (Playwright, Chromium):
1. `npm run build` and serve `dist/` (e.g. `npx http-server dist -p 5190 -c-1`).
2. Open it, log in once (PIN 1111) so the database exists.
3. In the browser console: load `gen.js` (paste it) and run `await __gen()` — about 8 minutes on a 2-core PC.
4. Reload, log in, and time the screens (Products, Stock, Reports, GST Saathi, counter search and bill save, backup).
