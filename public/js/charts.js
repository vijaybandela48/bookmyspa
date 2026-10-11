// charts.js — small, dependency-free SVG charts for BookMySpa Insights.
// Palette validated for colour-blind separation and contrast (dataviz checks):
//   eucalyptus #1F8A6A · amber #C77A1A · hibiscus #B5485D · indigo #5B6FB5
// Marks: bars ≤24px with 4px rounded ends (square at the baseline), 2px lines, ≥8px dots
// with a 2px surface ring, hairline solid gridlines. Every chart has a hover tooltip and a table view.
(function () {
  const C = ['#1F8A6A', '#C77A1A', '#B5485D', '#5B6FB5'];
  const RAMP = ['#EEF5F1', '#C7E3D6', '#8CC6AC', '#4FA585', '#1F8A6A', '#0E5A45'];
  const GRID = '#E4E8E2', INK = '#1F1B24', SOFT = '#6A6573', SURFACE = '#FCFDFB';
  const NS = 'http://www.w3.org/2000/svg';
  const reduce = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = (tag, attrs = {}, parent) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v); if (parent) parent.appendChild(n); return n; };
  const txt = (parent, x, y, s, attrs = {}) => { const t = el('text', { x, y, fill: SOFT, 'font-size': 11.5, 'font-family': 'Figtree, system-ui, sans-serif', ...attrs }, parent); t.textContent = s; return t; };
  const compact = (v) => { const a = Math.abs(v); return a >= 1e7 ? (v / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr' : a >= 1e5 ? (v / 1e5).toFixed(1).replace(/\.0$/, '') + 'L' : a >= 1e3 ? (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(Math.round(v * 10) / 10); };
  const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
  // column with a 4px rounded top and a square base
  const colPath = (x, y, w, h, r = 4) => { r = Math.min(r, w / 2, h); return h <= 0 ? '' : `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
  const barPath = (x, y, w, h, r = 4) => { r = Math.min(r, h / 2, w); return w <= 0 ? '' : `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; };

  // ---------- one shared tooltip ----------
  let tip;
  function showTip(evt, title, rows) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.replaceChildren();
    const h = document.createElement('div'); h.className = 'chart-tip-title'; h.textContent = title; tip.appendChild(h);
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'chart-tip-row';
      if (r.color) { const k = document.createElement('span'); k.className = 'chart-tip-key'; k.style.background = r.color; row.appendChild(k); }
      const v = document.createElement('strong'); v.textContent = r.value; row.appendChild(v);
      if (r.label) { const l = document.createElement('span'); l.textContent = r.label; row.appendChild(l); }
      tip.appendChild(row);
    }
    const box = evt.target && evt.target.getBoundingClientRect ? evt.target.getBoundingClientRect() : null;
    const x = evt.clientX ?? (box ? box.left + box.width / 2 : 0), y = evt.clientY ?? (box ? box.top : 0);
    tip.style.display = 'block';
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2)) + 'px';
    tip.style.top = Math.max(8, y - hgt - 14) + 'px';
  }
  const hideTip = () => { if (tip) tip.style.display = 'none'; };
  const bindTip = (node, title, rows) => {
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', title + ': ' + rows.map((r) => (r.label ? r.label + ' ' : '') + r.value).join(', '));
    node.addEventListener('pointermove', (e) => showTip(e, title, rows));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', (e) => showTip(e, title, rows));
    node.addEventListener('blur', hideTip);
  };

  function frame(container, height) {
    container.replaceChildren();
    const width = Math.max(280, container.clientWidth || 600);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', class: 'chart-svg' }, container);
    return { svg, width, height };
  }
  function yAxis(svg, m, w, h, max, fmt) {
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, y = m.t + h - (h * i) / 4;
      el('line', { x1: m.l, x2: m.l + w, y1: y, y2: y, stroke: GRID, 'stroke-width': 1 }, svg);
      txt(svg, m.l - 8, y + 4, fmt(v), { 'text-anchor': 'end' });
    }
  }
  function xLabels(svg, labels, xs, y) {
    const every = Math.ceil(labels.length / Math.max(1, Math.floor((xs[xs.length - 1] - xs[0] + 60) / 64)));
    labels.forEach((l, i) => { if (i % every === 0 || i === labels.length - 1 && labels.length < 14) txt(svg, xs[i], y, l, { 'text-anchor': 'middle' }); });
  }
  const animateIn = (nodes, prop = 'grow') => {
    if (reduce()) return;
    nodes.forEach((n, i) => { n.style.animationDelay = Math.min(i * 28, 700) + 'ms'; n.classList.add(prop); });
  };

  // ---------- columns (one series, or stacked) ----------
  function columns(container, { labels, series, format = compact, height = 240, stacked = true }) {
    const { svg, width } = frame(container, height);
    const m = { t: 16, r: 12, b: 28, l: 48 }, w = width - m.l - m.r, h = height - m.t - m.b;
    const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const max = niceMax(Math.max(...totals, 0));
    yAxis(svg, m, w, h, max, format);
    const band = w / labels.length, bw = Math.min(24, Math.max(3, band * 0.62));
    const xs = labels.map((_, i) => m.l + band * i + band / 2);
    const bars = [];
    labels.forEach((lab, i) => {
      const g = el('g', { class: 'col' }, svg);
      let base = m.t + h;
      series.forEach((s, si) => {
        const v = s.values[i] || 0; if (!v) return;
        const bh = (v / max) * h;
        const top = si === series.length - 1 || series.slice(si + 1).every((t) => !(t.values[i] || 0));
        const y = base - bh;
        const p = top ? colPath(xs[i] - bw / 2, y, bw, bh - (si ? 2 : 0)) : `M${xs[i] - bw / 2},${base - (si ? 2 : 0)}V${y}H${xs[i] + bw / 2}V${base - (si ? 2 : 0)}Z`;
        el('path', { d: p, fill: s.color }, g);
        base = y;
      });
      const hit = el('rect', { x: m.l + band * i, y: m.t, width: band, height: h, fill: 'transparent' }, g);
      bindTip(hit, lab, series.map((s) => ({ color: s.color, value: format(s.values[i] || 0), label: series.length > 1 ? s.name : '' })).concat(series.length > 1 ? [{ value: format(totals[i]), label: 'total' }] : []));
      g.style.transformOrigin = `${xs[i]}px ${m.t + h}px`;
      bars.push(g);
    });
    el('line', { x1: m.l, x2: m.l + w, y1: m.t + h, y2: m.t + h, stroke: '#CBD2C9', 'stroke-width': 1 }, svg);
    xLabels(svg, labels, xs, height - 8);
    // label the peak only
    const peak = totals.indexOf(Math.max(...totals));
    if (totals[peak] > 0) txt(svg, xs[peak], m.t + h - (totals[peak] / max) * h - 6, format(totals[peak]), { 'text-anchor': 'middle', fill: INK, 'font-weight': 600 });
    animateIn(bars);
  }

  // ---------- horizontal bars ----------
  function hbars(container, { items, format = compact, sub, color = C[0] }) {
    const rowH = 34, height = Math.max(60, items.length * rowH + 10);
    const { svg, width } = frame(container, height);
    const labelW = Math.min(170, width * 0.38), m = { l: labelW + 10, r: 64 }, w = width - m.l - m.r;
    const max = Math.max(...items.map((i) => i.value), 1);
    const bars = [];
    items.forEach((it, i) => {
      const y = 6 + i * rowH, bw = Math.max(2, (it.value / max) * w);
      const g = el('g', { class: 'hbar' }, svg);
      const name = txt(g, labelW, y + 16, it.name.length > 26 ? it.name.slice(0, 25) + '…' : it.name, { 'text-anchor': 'end', fill: INK, 'font-size': 12.5 });
      el('rect', { x: m.l, y: y + 4, width: w, height: 18, fill: '#F1F4EF', rx: 4 }, g);
      el('path', { d: barPath(m.l, y + 4, bw, 18), fill: it.color || color }, g);
      txt(g, m.l + bw + 8, y + 17, format(it.value), { fill: INK, 'font-weight': 600 });
      const hit = el('rect', { x: 0, y, width, height: rowH, fill: 'transparent' }, g);
      bindTip(hit, it.name, [{ value: format(it.value), label: '' }].concat(sub ? [{ value: sub(it), label: '' }] : []));
      g.style.transformOrigin = `${m.l}px ${y}px`;
      bars.push(g);
      name.setAttribute('class', 'no-anim');
    });
    animateIn(bars, 'grow-x');
  }

  // ---------- line (with gaps for missing values) ----------
  function line(container, { labels, values, format = (v) => String(v), min, max, height = 200, color = C[0] }) {
    const { svg, width } = frame(container, height);
    const m = { t: 18, r: 18, b: 28, l: 40 }, w = width - m.l - m.r, h = height - m.t - m.b;
    const vals = values.filter((v) => v !== null);
    const lo = min ?? Math.min(...vals), hi = max ?? Math.max(...vals);
    for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) / 4) * i, y = m.t + h - (h * i) / 4; el('line', { x1: m.l, x2: m.l + w, y1: y, y2: y, stroke: GRID }, svg); txt(svg, m.l - 8, y + 4, format(v), { 'text-anchor': 'end' }); }
    const xs = labels.map((_, i) => m.l + (labels.length === 1 ? w / 2 : (w * i) / (labels.length - 1)));
    const yOf = (v) => m.t + h - ((v - lo) / (hi - lo || 1)) * h;
    let d = '', pen = false;
    values.forEach((v, i) => { if (v === null) { pen = false; return; } d += (pen ? 'L' : 'M') + xs[i] + ',' + yOf(v); pen = true; });
    const path = el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', pathLength: 1, class: reduce() ? '' : 'draw' }, svg);
    values.forEach((v, i) => {
      if (v === null) return;
      el('circle', { cx: xs[i], cy: yOf(v), r: 5, fill: color, stroke: SURFACE, 'stroke-width': 2, class: reduce() ? '' : 'pop-in', style: `animation-delay:${600 + i * 60}ms` }, svg);
      const hit = el('circle', { cx: xs[i], cy: yOf(v), r: 14, fill: 'transparent' }, svg);
      bindTip(hit, labels[i], [{ value: format(v), label: '' }]);
    });
    const last = values.map((v, i) => [v, i]).filter(([v]) => v !== null).pop();
    if (last) txt(svg, xs[last[1]], yOf(last[0]) - 12, format(last[0]), { 'text-anchor': 'middle', fill: INK, 'font-weight': 600 });
    xLabels(svg, labels, xs, height - 8);
    return path;
  }

  // ---------- heatmap (sequential, one hue) ----------
  function heatmap(container, { rows, cols, values, unit = 'visits' }) {
    const cell = 22, gap = 3, left = 40, top = 22;
    const flat = values.flat(), max = Math.max(...flat, 1);
    const need = left + cols.length * (cell + gap);
    const avail = Math.max(280, container.clientWidth || 600);
    const width = Math.max(avail, need);
    const cw = Math.max(cell, Math.floor((width - left) / cols.length) - gap);
    const height = top + rows.length * (cell + gap) + 40;
    container.replaceChildren();
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: width > avail ? width : '100%', height, role: 'img', class: 'chart-svg' }, container);
    cols.forEach((c, j) => { if (cols.length <= 12 || j % 2 === 0) txt(svg, left + j * (cw + gap) + cw / 2, 14, c, { 'text-anchor': 'middle' }); });
    const cells = [];
    rows.forEach((r, i) => {
      txt(svg, left - 8, top + i * (cell + gap) + 15, r, { 'text-anchor': 'end' });
      cols.forEach((c, j) => {
        const v = values[i][j], step = v === 0 ? 0 : Math.min(RAMP.length - 1, 1 + Math.floor((v / max) * (RAMP.length - 2) + 0.0001));
        const rect = el('rect', { x: left + j * (cw + gap), y: top + i * (cell + gap), width: cw, height: cell, rx: 4, fill: RAMP[step] }, svg);
        bindTip(rect, `${r} · ${c}`, [{ value: `${v} ${unit}`, label: '' }]);
        cells.push(rect);
      });
    });
    // scale legend
    const ly = top + rows.length * (cell + gap) + 14;
    txt(svg, left, ly + 10, 'Fewer', {});
    RAMP.forEach((c, i) => el('rect', { x: left + 44 + i * 20, y: ly, width: 18, height: 12, rx: 3, fill: c }, svg));
    txt(svg, left + 44 + RAMP.length * 20 + 6, ly + 10, 'More', {});
    if (!reduce()) cells.forEach((c, i) => { c.style.animationDelay = Math.min(i * 6, 900) + 'ms'; c.classList.add('fade-in'); });
  }

  // ---------- part-to-whole: one 100% bar + legend ----------
  function share(container, { items, format = compact }) {
    const total = items.reduce((a, i) => a + i.value, 0);
    container.replaceChildren();
    const bar = document.createElement('div'); bar.className = 'share-bar';
    const legend = document.createElement('div'); legend.className = 'chart-legend';
    items.forEach((it, i) => {
      if (!it.value) return;
      const seg = document.createElement('span'); seg.style.flexGrow = it.value; seg.style.background = it.color || C[i];
      seg.tabIndex = 0;
      const p = Math.round((it.value / total) * 100);
      seg.addEventListener('pointermove', (e) => showTip(e, it.name, [{ value: format(it.value), label: `${p}%` }])); seg.addEventListener('pointerleave', hideTip);
      seg.addEventListener('focus', (e) => showTip(e, it.name, [{ value: format(it.value), label: `${p}%` }])); seg.addEventListener('blur', hideTip);
      bar.appendChild(seg);
      const l = document.createElement('span'); const k = document.createElement('i'); k.style.background = it.color || C[i]; l.appendChild(k);
      const t = document.createElement('span'); t.textContent = `${it.name} ${p}%`; l.appendChild(t); legend.appendChild(l);
    });
    if (!total) { const e = document.createElement('p'); e.className = 'helper-text'; e.textContent = 'No visits in this period.'; container.appendChild(e); return; }
    container.appendChild(bar); container.appendChild(legend);
    if (!reduce()) bar.classList.add('grow-x');
  }

  function legend(container, series) {
    const lg = document.createElement('div'); lg.className = 'chart-legend';
    for (const s of series) { const l = document.createElement('span'); const k = document.createElement('i'); k.style.background = s.color; l.appendChild(k); const t = document.createElement('span'); t.textContent = s.name; l.appendChild(t); lg.appendChild(l); }
    container.appendChild(lg);
  }
  function table(container, headers, rows) {
    container.replaceChildren();
    const t = document.createElement('table'); t.className = 'chart-table';
    const hr = document.createElement('tr'); headers.forEach((h) => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(hr); t.appendChild(thead);
    const tb = document.createElement('tbody');
    rows.forEach((r) => { const tr = document.createElement('tr'); r.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }); tb.appendChild(tr); });
    t.appendChild(tb); container.appendChild(t);
  }
  // counts a number up once it scrolls into view
  function countUp(node, to, fmt) {
    if (reduce() || !to) { node.textContent = fmt(to); return; }
    const start = performance.now(), dur = 900;
    const step = (now) => { const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3); node.textContent = fmt(to * e); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  window.BMSChart = { C, RAMP, compact, columns, hbars, line, heatmap, share, legend, table, countUp, hideTip };
})();
