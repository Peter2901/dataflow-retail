// Type-to-find product box. Replaces dropdowns that listed every product (25,000 products × every
// purchase line made the page crawl). Uses the same smart search as the counter (Hindi/Odia names, typos).
import React, { useMemo, useState } from 'react';
import { smartSearch } from '../lib/search.js';

export default function ProductPicker({ products, value, onChange, label, id, ariaLabel = 'Product', placeholder = 'Type name or barcode', extra, className = '' }) {
  const cur = useMemo(() => (value ? products.find(p => p.id === value) : null), [products, value]);
  const [q, setQ] = useState(null);                 // null = not typing
  const [hi, setHi] = useState(0);
  const list = useMemo(() => (q && q.trim().length >= 2 ? smartSearch(q, products, 10) : []), [q, products]);
  const pick = p => { onChange(p ? p.id : ''); setQ(null); };
  const box = (
    <div className={`picker ${className}`}>
      <input className="input" id={id} aria-label={ariaLabel} autoComplete="off" placeholder={placeholder}
        value={q ?? (cur ? cur.name : '')}
        onFocus={() => setQ('')}
        onChange={e => { setQ(e.target.value); setHi(0); }}
        onBlur={() => setTimeout(() => setQ(null), 150)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, list.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && list[hi]) { e.preventDefault(); pick(list[hi]); }
          else if (e.key === 'Escape') setQ(null);
        }} />
      {q !== null && list.length > 0 && (
        <div className="picker-list" role="listbox">
          {list.map((p, i) => (
            <button type="button" role="option" aria-selected={i === hi} key={p.id} className={i === hi ? 'on' : ''} onMouseDown={e => { e.preventDefault(); pick(p); }}>
              <span>{p.name}</span><span className="small muted">{extra ? extra(p) : `₹${p.price}`}</span>
            </button>
          ))}
        </div>
      )}
      {q !== null && q.trim().length >= 2 && !list.length && <div className="picker-list"><span className="small muted" style={{ padding: 8 }}>No product found</span></div>}
    </div>
  );
  return label ? <div className="field"><span className="field-label">{label}</span>{box}</div> : box;
}
