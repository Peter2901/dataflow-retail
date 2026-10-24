// Injected into each device: a fingerprint of everything that must be the same on every device after sync.
(() => {
  window.__syncDigest = async (detail = false) => {
    const X = window.__dfr, { db } = X;
    const r2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
    const h = async arr => (await X.util.sha256(arr.join('|'))).slice(0, 16);
    const sales = await db.sales.toArray();
    const nos = sales.map(s => s.no);
    const batches = await db.batches.toArray();
    const cust = await X.parties.partyBalances('cust'), supp = await X.parties.partyBalances('supp');
    const custs = await db.customers.toArray();
    const bal = await X.accounts.balances();
    const chain = await X.sales.verifyChain('S1');
    const today = X.util.todayISO();
    const ds = (await X.daysums.daySumsBetween('S1', today, today))[0];
    const sumToday = r2(sales.filter(s => s.storeId === 'S1' && s.ts >= X.util.dayStart()).reduce((a, s) => a + (s.type === 'return' ? -1 : 1) * s.totals.payable, 0));
    const lists = {
      sales: sales.map(s => s.id).sort(),
      stock: batches.map(b => `${b.id}:${Math.round(b.qty * 1000)}`).sort(),
      cust: Object.entries(cust).filter(([, v]) => Math.abs(v) > 0.004).map(([k, v]) => `${k}:${v.toFixed(2)}`).sort(),
      supp: Object.entries(supp).filter(([, v]) => Math.abs(v) > 0.004).map(([k, v]) => `${k}:${v.toFixed(2)}`).sort(),
      points: custs.map(c => `${c.id}:${c.points || 0}`).sort(),
      journal: (await db.journal.toCollection().primaryKeys()).sort(),
      purchases: (await db.purchases.toCollection().primaryKeys()).sort(),
      moves: (await db.stockMoves.toArray()).map(m => m.sid).sort(),
    };
    const out = {
      sales: sales.length, dupBillNos: nos.length - new Set(nos).size, batches: batches.length, journal: lists.journal.length, moves: lists.moves.length,
      dupMoves: lists.moves.length - new Set(lists.moves).size, purchases: lists.purchases.length, customers: custs.length,
      trialBalance: r2(Object.values(bal).reduce((a, v) => a + v, 0)), chainProblems: chain.problems.length, chainFirst: chain.problems[0] || null,
      todayDaySum: ds.total, todayBills: sumToday, negativePoints: custs.filter(c => (c.points || 0) < 0).length,
      status: window.__dfrSyncStatus ? window.__dfrSyncStatus() : null,
    };
    for (const [k, v] of Object.entries(lists)) out['#' + k] = await h(v);
    if (detail) {
      out.lists = lists;
      const by = {};
      for (const s of sales) if (s.customerId) (by[s.customerId] ||= []).push(s);
      out.cust = Object.fromEntries(custs.map(c => { const bs = by[c.id] || []; const eff = bs.reduce((a, s) => a + (s.pointsEarned || 0) - (s.pointsUsed || 0), 0); return [c.id, { p: c.points || 0, base: c.base?.points ?? null, n: bs.length, eff, calc: (c.base?.points ?? 0) + eff, oc: c._oc || '', upd: c.updatedAt }]; }));
    }
    return out;
  };
})();
