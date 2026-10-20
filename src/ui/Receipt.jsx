import React from 'react';
import { inr, fmtDT, num, maskPhone } from '../lib/util.js';

export function receiptText(sale, s) {
  const L = [];
  L.push(`*${s.storeName}*`);
  L.push(`${sale.type === 'return' ? 'Credit note' : 'Bill'} ${sale.no} · ${fmtDT(sale.ts)}`);
  L.push('');
  sale.lines.forEach(l => L.push(`${l.name}${l.localName ? ' / ' + l.localName : ''} × ${num(l.qty, l.uom === 'KG' ? 3 : 0)} = ${inr(l.total)}`));
  L.push('');
  if (sale.totals.lineDisc + sale.totals.billDisc > 0) L.push(`Discounts: −${inr(sale.totals.lineDisc + sale.totals.billDisc)}`);
  L.push(`*Total: ${inr(sale.totals.payable)}*`);
  if (sale.totals.savings > 0) L.push(`You saved ${inr(sale.totals.savings)} on MRP today 🎉`);
  if (sale.pointsEarned) L.push(`Points earned: ${sale.pointsEarned}`);
  L.push(`Paid by: ${sale.payments.map(p => p.mode.toUpperCase()).join(' + ')}`);
  L.push('');
  L.push('Thank you for shopping with us!');
  return L.join('\n');
}

export default function Receipt({ sale, settings: s }) {
  const taxByRate = {};
  sale.lines.forEach(l => {
    const k = l.gst;
    taxByRate[k] = taxByRate[k] || { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    taxByRate[k].taxable += l.taxable; taxByRate[k].cgst += l.cgst; taxByRate[k].sgst += l.sgst; taxByRate[k].igst += l.igst;
  });
  const t = sale.totals;
  return (
    <div className="receipt print-area">
      <h4>{s.storeName}</h4>
      <div className="c">{s.address}</div>
      {s.gstin ? <div className="c">GSTIN: {s.gstin}</div> : <div className="c">GSTIN: [not set]</div>}
      <div className="c"><b>{sale.type === 'return' ? 'CREDIT NOTE' : sale.b2b ? 'TAX INVOICE' : 'BILL OF SUPPLY / TAX INVOICE'}</b></div>
      <hr />
      <div>No: {sale.no}{sale.origNo ? ` (against ${sale.origNo})` : ''}</div>
      <div>Date: {fmtDT(sale.ts)} · {sale.cashierName}</div>
      {sale.customerName && <div>Customer: {sale.customerName} {sale.customerPhone ? '· ' + maskPhone(sale.customerPhone) : ''}</div>}
      {sale.b2b?.gstin && <div>Buyer GSTIN: {sale.b2b.gstin}</div>}
      <hr />
      <table><tbody>
        {sale.lines.map((l, i) => (
          <React.Fragment key={i}>
            <tr><td colSpan="3">{l.name}{l.localName ? <div className="loc">{l.localName}</div> : null}</td></tr>
            <tr><td>{num(l.qty, l.uom === 'KG' ? 3 : 0)} × {l.unitPrice}</td><td className="r">MRP {l.mrp}</td><td className="r">{l.total.toFixed(2)}</td></tr>
            <tr><td colSpan="3" style={{ fontSize: 10 }}>HSN {l.hsn} · GST {l.gst}%{l.lineDisc ? ` · disc ${l.lineDisc.toFixed(2)}` : ''}</td></tr>
          </React.Fragment>
        ))}
      </tbody></table>
      <hr />
      <table><tbody>
        <tr><td>Items / Qty</td><td className="r">{t.items} / {num(t.qty, 3)}</td></tr>
        {(t.lineDisc + t.billDisc) > 0 && <tr><td>Discounts</td><td className="r">−{(t.lineDisc + t.billDisc).toFixed(2)}</td></tr>}
        <tr><td>Taxable value</td><td className="r">{t.taxable.toFixed(2)}</td></tr>
        {t.cgst > 0 && <tr><td>CGST</td><td className="r">{t.cgst.toFixed(2)}</td></tr>}
        {t.sgst > 0 && <tr><td>SGST</td><td className="r">{t.sgst.toFixed(2)}</td></tr>}
        {t.igst > 0 && <tr><td>IGST</td><td className="r">{t.igst.toFixed(2)}</td></tr>}
        {t.roundOff !== 0 && <tr><td>Round off</td><td className="r">{t.roundOff.toFixed(2)}</td></tr>}
        <tr><td><b>TOTAL</b></td><td className="r"><b>{inr(t.payable)}</b></td></tr>
      </tbody></table>
      <hr />
      <table><tbody>
        <tr><td>GST%</td><td className="r">Taxable</td><td className="r">Tax</td></tr>
        {Object.entries(taxByRate).map(([r, v]) => <tr key={r}><td>{r}%</td><td className="r">{v.taxable.toFixed(2)}</td><td className="r">{(v.cgst + v.sgst + v.igst).toFixed(2)}</td></tr>)}
      </tbody></table>
      <hr />
      {sale.payments.map((p, i) => <div key={i}>{p.mode.toUpperCase()} {inr(p.amount)}{p.ref ? ` · ${p.ref}` : ''}{p.change ? ` · change ${inr(p.change)}` : ''}</div>)}
      {t.savings > 0 && <div className="c" style={{ marginTop: 6 }}><b>You saved {inr(t.savings)} on MRP</b></div>}
      {sale.pointsEarned ? <div className="c">Points earned: {sale.pointsEarned}</div> : null}
      <div className="c" style={{ marginTop: 6, fontSize: 9 }}>Chain {sale.hash?.slice(0, 16)}</div>
      <div className="c">Thank you! Visit again.</div>
    </div>
  );
}
