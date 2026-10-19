import React from 'react';

// Small area/line chart drawn to scale. Labels use theme colours (see .chart in styles).
export function LineChart({ data, height = 180, money = true }) {
  const W = 640, H = height, L = 52, R = 14, T = 14, B = 26;
  const max = Math.max(1, ...data.map(d => d.value));
  const nice = niceMax(max);
  const x = i => L + (data.length <= 1 ? 0 : (i * (W - L - R)) / (data.length - 1));
  const y = v => T + (H - T - B) * (1 - v / nice);
  const pts = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ');
  const ticks = [0, nice / 2, nice];
  const fmt = v => (money ? '₹' : '') + (v >= 100000 ? (v / 100000).toFixed(1) + 'L' : v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : Math.round(v));
  const last = data.length - 1;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sales trend">
      {ticks.map(t => <g key={t}><line className="grid-line" x1={L} x2={W - R} y1={y(t)} y2={y(t)} /><text x={L - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
      {data.length > 1 && <polygon className="area" points={`${x(0)},${y(0)} ${pts} ${x(last)},${y(0)}`} />}
      <polyline className="line" points={pts} />
      {data.map((d, i) => ((i % Math.ceil(data.length / 7) === 0 && last - i >= Math.ceil(data.length / 7) / 2) || i === last) && <text key={i} x={x(i)} y={H - 8} textAnchor={i === last ? 'end' : i === 0 ? 'start' : 'middle'}>{d.label}</text>)}
      {last >= 0 && <circle className="pt" cx={x(last)} cy={y(data[last].value)} r="4.5" />}
    </svg>
  );
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
