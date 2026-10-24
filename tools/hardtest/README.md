# Hard tests (high volume, every feature)

These scripts drive the real app in a real Chromium (Playwright) and check that everything still adds up.
They were run on 24 Oct 2026 on a fresh sample store and on a "huge" store (25,000 products, 30,000 customers,
2.5 lakh bills, 10 lakh stock moves — made with `tools/stress/gen.js`).

All scripts take a work folder `S` as the first argument. In it: `site-stress/` (the app built with the test hooks:
`node build.mjs <S> stress <S>/site-stress`, needs esbuild and local copies of React/Dexie — see `build.mjs`),
and for the huge store a browser profile made by `tools/stress`. The huge store lives at `http://localhost:5190`
(browser data belongs to the exact port).

| Test | Command | What it checks |
|---|---|---|
| Engine | `node engine/engine.mjs <S> fresh 5201 1500 4 2 fresh1` (or a profile folder + port 5190 for the huge store) | 3,000 mixed jobs from 2 tabs × 4 workers at once (bills with units, wholesale, offers, points, GSTIN, split/udhaar payments; returns; purchases; supplier payments; debit notes; write-offs; branch transfers; expenses). Then: bill maths to the paisa, bill numbers unique with no gaps, tamper chain, stock = stock moves, every books entry balanced, trial balance 0, balance sheet balances, udhaar, points, returns never above the bill, GSTR-1/3B = bills, day totals = bills, supplier balances |
| Fuzz | `node fuzz/run.mjs <S>` | 60,000 random bills, 38,000 random returns, 20,000 offer sets, unit conversions, scale barcodes, EAN, invoice numbers, odd search typing, GST set-off and late fee |
| Every screen | `node ui/pages.mjs <S> <profile> <port>` | every page and tab in English, Hindi and Odia; broken text (NaN, undefined…); each role's menu |
| Counter | `node ui/counter.mjs <S> <profile> <port>` | 32 counter flows: scan, search, qty, cash with change, UPI, card, split, udhaar, points, GSTIN bill, hold/recall, cancel with PIN, price change with PIN, wholesale (button and customer), loose items, scale stickers, units, unknown barcode, returns, double press, 20-scan burst, drawer, X/Z report, cashier limits, wrong-PIN lock |
| Office | `node ui/office.mjs <S> <profile> <port>` | 35 flows: products (units, prices, duplicates, export, labels), stock (write-off, theft PIN, count, transfer), expiry, purchase bill, suppliers and payments, orders to suppliers, offers, customers, udhaar received, accounts, Tally export, reports and exports, salary run/pay once, WhatsApp order → bill, store details, users, stores, tamper check, Ask your shop |
| Sync | `node sync/volume.mjs <S> 250 5212 54332` | 4 counters + a phone on one cloud (`tools/stress/mock-supabase.mjs`), all working at once, one counter offline for a minute; every device must end with the same bills, stock, dues, points, books and stock moves |
| Restore | `node ui/restore.mjs <S> <profile> <port>` | restores the 106 MB backup through the screen and times it |
| Same moment | `node engine/race.mjs <S> 5251` | 10 returns of one bill fired at once from 2 tabs (exactly one may be saved, never more than the bill); 12 purchases at once (numbers unique) |
| Timings | `node ui/timing.mjs <S> <huge profile> 5190` | Accounts, balance sheet, GST Saathi, duplicates, count tab, udhaar on the huge store |
| Duplicates | `node fuzz/dups.run.mjs <S> <item list json>` | the duplicate finder gives the same pairs as the old every-pair check, and its speed |
| Everything | `./run-all.sh <S>` | all of the above in order, summary in `<S>/final/summary.txt` |
| Supabase SQL | `psql -d <test db> -f pg/test.sql` (as a Postgres superuser) | `supabase/setup.sql` on real Postgres: safe to run twice, shop A/B isolation, row numbers, owner-app functions, the download index |

`engine/repair.mjs` fixes test data made by an older `gen.js` (round-off lines, party accounts).
