import React, { useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, PageHead, Table, Btn, Card, Stat, Badge } from '../ui/kit.jsx';
import { fmtDT, sha256, groupBy, inr } from '../lib/util.js';
import { verifyChain } from '../lib/sales.js';

const LABEL = { bill: 'Bill', return: 'Return', login: 'Login', logout: 'Lock', price_override: 'Price changed at counter', bill_cancel: 'Bill cancelled', drawer_open: 'Drawer opened (no sale)', write_off: 'Stock written off', blocked_scan: 'Expired item scanned', negative_stock: 'Sold beyond system stock', shift_open: 'Shift opened', shift_close: 'Shift closed', price_change: 'Price edited', purchase: 'Purchase saved', debit_note: 'Debit note', receipt: 'Payment received', supplier_payment: 'Supplier paid', customer_erased: 'Customer data erased', payroll_run: 'Salary run', setup: 'Setup' };
const RISKY = new Set(['price_override', 'bill_cancel', 'drawer_open', 'write_off', 'negative_stock', 'customer_erased']);

export default function Audit() {
  const { storeId } = useApp();
  const log = useLive(() => db.audit.orderBy('ts').reverse().limit(400).toArray(), [], []);
  const shifts = useLive(() => db.shifts.toArray(), [], []);
  const [chain, setChain] = useState(null);
  const [logCheck, setLogCheck] = useState(null);
  const verifyBills = async () => setChain(await verifyChain(storeId));
  const verifyLog = async () => {
    const all = await db.audit.orderBy('ts').toArray();
    let bad = 0;
    // One chain per device: this device's own rows, and each other counter's rows.
    for (const rows of Object.values(groupBy(all, a => a._oc || 'here'))) {
      let prev = 'GENESIS';
      for (const a of rows) { const h = await sha256(prev + '|' + a.ts + '|' + a.action + '|' + JSON.stringify(a.detail || {})); if (a.prevHash !== prev || h !== a.hash) bad++; prev = a.hash; }
    }
    setLogCheck({ count: all.length, bad });
  };
  // Alerts: more than 3 risky actions by one person within an hour, and cash shortfalls.
  const hourAgo = Date.now() - 3600000;
  const recentRisky = log.filter(a => RISKY.has(a.action) && a.ts >= hourAgo);
  const byUser = Object.entries(groupBy(recentRisky, a => a.userName)).filter(([, v]) => v.length > 3);
  const shortShifts = shifts.filter(s => s.closedAt && (s.variance || 0) < -50);
  return (
    <div className="stack">
      <PageHead title="Security & audit" sub="Every bill is chained to the one before it, so a deleted or edited bill is caught. Every sensitive action is logged." />
      <div className="grid g3">
        <Stat label="Risky actions, last hour" value={recentRisky.length} tone={byUser.length ? 'bad' : undefined} sub={byUser.length ? `Check: ${byUser.map(([u]) => u).join(', ')}` : 'Normal'} />
        <Stat label="Shifts with cash short" value={shortShifts.length} tone={shortShifts.length ? 'warn' : undefined} sub={shortShifts.length ? `${inr(shortShifts.reduce((a, s) => a + s.variance, 0))} total` : 'None'} />
        <Stat label="Log entries" value={log.length} />
      </div>
      <div className="grid g2">
        <Card title="Check bills for tampering" actions={<Btn kind="primary" size="sm" onClick={verifyBills}>Check now</Btn>}>
          {!chain ? <p className="small muted">Re-checks every bill’s fingerprint against the chain.</p> : chain.problems.length === 0
            ? <p><Badge tone="ok">All {chain.count} bills intact</Badge></p>
            : <div className="stack"><Badge tone="bad">{chain.problems.length} problems found</Badge>{chain.problems.slice(0, 10).map((p, i) => <div key={i} className="small">{p.no}: {p.issue}</div>)}</div>}
        </Card>
        <Card title="Check the audit log" actions={<Btn size="sm" onClick={verifyLog}>Check now</Btn>}>
          {!logCheck ? <p className="small muted">The log is chained the same way, so entries can’t be quietly removed.</p> : logCheck.bad ? <Badge tone="bad">{logCheck.bad} broken entries</Badge> : <Badge tone="ok">All {logCheck.count} entries intact</Badge>}
        </Card>
      </div>
      <div className="card"><Table rows={log} cols={[
        { label: 'When', render: a => fmtDT(a.ts) }, { label: 'Who', key: 'userName' },
        { label: 'What', render: a => <Badge tone={RISKY.has(a.action) ? 'warn' : 'neutral'}>{LABEL[a.action] || a.action}</Badge> },
        { label: 'Details', render: a => <span className="small">{Object.entries(a.detail || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ')}</span> },
      ]} /></div>
    </div>
  );
}
