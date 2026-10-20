import React, { useEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { useApp, Modal, Btn, Tabs, Table, Input } from './kit.jsx';
import { barcodeFormat } from '../lib/barcode.js';
import { inArtifact } from '../lib/util.js';

// Paper layouts. Sizes in mm. "Start at" lets a half-used A4 sheet be used again.
export const LAYOUTS = {
  roll5025: { label: 'Label printer 50×25 mm', w: 50, h: 25, page: 'size: 50mm 25mm; margin: 0', perPage: 1 },
  a4_65: { label: 'A4 sheet, 65 per page (38×21 mm)', w: 38.1, h: 21.2, cols: 5, rows: 13, top: 10.7, left: 4.7, gapX: 2.5, gapY: 0, page: 'size: A4; margin: 0' },
  a4_40: { label: 'A4 sheet, 40 per page (52×30 mm)', w: 52.5, h: 29.7, cols: 4, rows: 10, top: 0, left: 0, gapX: 0, gapY: 0, page: 'size: A4; margin: 0' },
  shelf: { label: 'Shelf-edge label 50×30 mm', w: 50, h: 30, cols: 4, rows: 9, top: 8, left: 5, gapX: 0, gapY: 2, page: 'size: A4; margin: 0' },
};

function Code({ code, h }) {
  const ref = useRef();
  useEffect(() => {
    if (!ref.current || !code) return;
    try {
      JsBarcode(ref.current, code, { format: barcodeFormat(code), height: 40, fontSize: 14, margin: 0, textMargin: 1, width: 2 });
      const w = ref.current.getAttribute('width'), hh = ref.current.getAttribute('height');
      ref.current.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(hh)}`);
      ref.current.setAttribute('preserveAspectRatio', 'none');
      ref.current.removeAttribute('width'); ref.current.removeAttribute('height');
    } catch { /* bad code: leave empty */ }
  }, [code]);
  return <svg ref={ref} style={{ width: '100%', height: h + 'mm', display: 'block' }} />;
}

function Sticker({ p, L, storeName }) {
  const small = L.h < 25;
  const save = Number(p.mrp) - Number(p.price);
  if (L === LAYOUTS.shelf) {
    return (
      <div className="stk" style={{ width: L.w + 'mm', height: L.h + 'mm' }}>
        <div className="stk-name" style={{ fontSize: '9pt' }}>{p.name}</div>
        <div><s style={{ fontSize: '7pt' }}>MRP ₹{p.mrp}</s> <b style={{ fontSize: '14pt' }}>₹{p.price}</b>{save > 0 && <span style={{ fontSize: '7pt' }}> SAVE ₹{save}</span>}</div>
        {p.barcode ? <Code code={p.barcode} h={9} /> : <div style={{ fontSize: '7pt' }}>PLU {p.plu}</div>}
        <div style={{ fontSize: '6pt' }}>{p.rack}{p.uom === 'KG' ? ` · ₹${p.price}/kg` : ''}</div>
      </div>
    );
  }
  return (
    <div className="stk" style={{ width: L.w + 'mm', height: L.h + 'mm' }}>
      {!small && <div className="stk-store">{storeName}</div>}
      <div className="stk-name" style={{ fontSize: small ? '6.5pt' : '7.5pt' }}>{p.name}</div>
      <div style={{ fontSize: small ? '7pt' : '8pt' }}>MRP ₹{p.mrp}{save > 0 && <> · <b>Our ₹{p.price}</b></>} <span style={{ fontSize: '5.5pt' }}>(incl. all taxes)</span></div>
      <Code code={p.barcode} h={small ? 9 : 12} />
    </div>
  );
}

/** items: [{ product, copies }] */
export default function Stickers({ items: init, defaultLayout = 'roll5025', title = 'Print barcode stickers', onClose }) {
  const { settings } = useApp();
  const [lay, setLay] = useState(defaultLayout);
  const [items, setItems] = useState(init);
  const [start, setStart] = useState(1);
  const L = LAYOUTS[lay];

  // This print job's paper size (overrides the 80 mm receipt size while open).
  useEffect(() => {
    const s = document.createElement('style');
    s.textContent = `@media print { @page { ${L.page}; } .receipt { width: auto; } }`;
    document.head.appendChild(s);
    return () => s.remove();
  }, [L]);

  const list = useMemo(() => items.flatMap(it => Array.from({ length: Math.max(0, Math.floor(Number(it.copies) || 0)) }, () => it.product)).filter(p => p.barcode || lay === 'shelf'), [items, lay]);
  const noCode = items.filter(it => Number(it.copies) > 0 && !it.product.barcode).length;
  const perPage = L.perPage || L.cols * L.rows;
  const skip = L.perPage ? 0 : Math.min(perPage - 1, Math.max(0, Number(start) - 1));
  const cells = [...Array(skip).fill(null), ...list];
  const pages = [];
  for (let i = 0; i < cells.length; i += perPage) pages.push(cells.slice(i, i + perPage));

  return (
    <Modal wide title={title} onClose={onClose} footer={<>
      <span className="grow small muted">{list.length} sticker(s){L.perPage ? '' : ` · ${pages.length} sheet(s)`}</span>
      <Btn onClick={onClose}>Close</Btn>
      {!inArtifact() && <Btn kind="primary" disabled={!list.length} onClick={() => window.print()}>Print</Btn>}
    </>}>
      <div className="stack">
        <Tabs value={lay} onChange={setLay} tabs={Object.entries(LAYOUTS).map(([value, l]) => ({ value, label: l.label }))} />
        <div className="row gap-s wrap">
          {!L.perPage && <Input label={`Start at position (1–${perPage}) on the first sheet`} type="number" min="1" max={perPage} value={start} onChange={e => setStart(e.target.value)} style={{ width: 120 }} id="stk-start" />}
          <p className="small muted grow" style={{ alignSelf: 'end' }}>
            {lay === 'roll5025' ? 'In the printer settings choose the label size 50 × 25 mm and scale 100%.' : 'Print at 100% scale ("Actual size"), not "Fit to page".'}
            {noCode > 0 && lay !== 'shelf' && ` ${noCode} item(s) have no barcode and are skipped — give them a store barcode in Products.`}
          </p>
        </div>
        <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto' }}>
          <Table rows={items.map((it, i) => ({ ...it, id: it.product.id + ':' + i, i }))} cols={[
            { label: 'Item', render: it => <><b>{it.product.name}</b><div className="small muted">{it.product.barcode || 'no barcode'}</div></> },
            { label: 'MRP', num: true, render: it => '₹' + it.product.mrp },
            { label: 'Copies', num: true, render: it => <input className="input" style={{ width: 80 }} type="number" min="0" value={it.copies} onChange={e => setItems(xs => xs.map((x, j) => j === it.i ? { ...x, copies: e.target.value } : x))} aria-label={`Copies of ${it.product.name}`} /> },
          ]} />
        </div>
        <div className="stk-preview">
          <div className="print-area">
            {L.perPage
              ? list.map((p, i) => <div key={i} className="stk-roll"><Sticker p={p} L={L} storeName={settings.storeName} /></div>)
              : pages.map((pg, i) => (
                <div key={i} className="stk-sheet" style={{ paddingTop: L.top + 'mm', paddingLeft: L.left + 'mm', gridTemplateColumns: `repeat(${L.cols}, ${L.w}mm)`, gridAutoRows: L.h + 'mm', columnGap: L.gapX + 'mm', rowGap: L.gapY + 'mm' }}>
                  {pg.map((p, j) => p ? <Sticker key={j} p={p} L={L} storeName={settings.storeName} /> : <div key={j} />)}
                </div>
              ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
