// Only in the stress-test build (vite build --mode stress): lets the test scripts drive the real app code.
import * as dbm from '../db.js';
import * as sales from '../lib/sales.js';
import * as billing from '../lib/billing.js';
import * as stock from '../lib/stock.js';
import * as sync from '../lib/sync.js';
import * as units from '../lib/units.js';
import * as accounts from '../lib/accounts.js';
import * as parties from '../lib/parties.js';
import * as util from '../lib/util.js';
import * as offers from '../lib/offers.js';
import * as insights from '../lib/insights.js';
import * as purchasing from '../lib/purchasing.js';
import * as search from '../lib/search.js';
import * as gst from '../lib/gst.js';
import * as daysums from '../lib/daysums.js';
import * as backup from '../lib/backup.js';
import * as products from '../lib/products.js';
import * as productTools from '../lib/productTools.js';
import * as excel from '../lib/excel.js';
import * as marg from '../lib/marg.js';
import * as match from '../lib/match.js';
import * as messages from '../lib/messages.js';
import * as khata from '../lib/khata.js';
import * as purchaseChecks from '../lib/purchaseChecks.js';
import * as cart from '../lib/cart.js';
import * as returns from '../lib/returns.js';
import * as stockOps from '../lib/stockOps.js';

export function install() {
  window.__dfr = { ...dbm, sales, billing, stock, sync, units, accounts, parties, util, offers, insights, purchasing, search, gst, daysums, backup, products, productTools, excel, marg, match, messages, khata, purchaseChecks, cart, returns, stockOps };
}
