'use strict';
// Shared helpers. DOM is always built with textContent / attributes, never innerHTML.

const HD = (() => {
  let csrf = null;

  async function session() {
    const r = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    const s = await r.json();
    csrf = s.csrf;
    return s;
  }

  async function api(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') {
      if (!csrf) await session();
      headers['X-CSRF-Token'] = csrf || '';
    }
    const r = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return handle(r, url);
  }

  async function upload(url, file) {
    if (!csrf) await session();
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': file.type || 'application/octet-stream',
        'X-CSRF-Token': csrf || '',
        'X-File-Name': encodeURIComponent(file.name).slice(0, 240),
      },
      body: file,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return handle(r, url);
  }

  // For non-JSON requests and responses (backup files). Adds the CSRF token; throws on errors.
  async function raw(method, url, { body, json, headers = {} } = {}) {
    if (!csrf) await session();
    const r = await fetch(url, {
      method,
      headers: { 'X-CSRF-Token': csrf || '', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!r.ok) await handle(r, url);
    return r;
  }

  // Saves a Blob as a file
  function saveBlob(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function handle(r, url) {
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* empty */
    }
    if (r.status === 401 && url !== '/api/login' && url !== '/api/dashboard') {
      location.href = '/login';
      throw new Error('Login required');
    }
    if (!r.ok) {
      const e = new Error((data && data.error) || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    applyAttrs(node, attrs);
    append(node, children);
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    applyAttrs(node, attrs);
    append(node, children);
    return node;
  }

  function applyAttrs(node, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.setAttribute('class', v);
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = Boolean(v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }

  function append(node, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  const nf = (d) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt = {
    n: (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '–' : nf(d).format(v)),
    pct: (v, d = 0) => (v === null || v === undefined ? '–' : `${nf(d).format(v * 100)} %`),
    bytes(v) {
      if (v === null || v === undefined) return '–';
      const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
      let i = 0;
      while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
      }
      return `${nf(v >= 100 || i === 0 ? 0 : 1).format(v)} ${u[i]}`;
    },
    uptime(s) {
      if (!s && s !== 0) return '–';
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
    },
    kr: (v, d = 2) => (v === null || v === undefined ? '–' : `${nf(d).format(v)} kr`),
    ago(ms) {
      if (!ms) return 'never';
      const s = Math.round((Date.now() - ms) / 1000);
      if (s < 60) return `${Math.max(s, 0)} s ago`;
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      return `${Math.round(s / 3600)} h ago`;
    },
    time: (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '–'),
  };

  // Map Redfish/Proxmox/TrueNAS states to the reserved status palette.
  function statusClass(s) {
    const v = String(s || '').toLowerCase();
    if (['ok', 'online', 'running', 'enabled', 'on', 'healthy', 'info'].includes(v)) return 'good';
    if (['warning', 'degraded', 'paused', 'suspended', 'notice'].includes(v)) return 'warning';
    if (['critical', 'error', 'faulted', 'offline', 'unavail', 'removed', 'alert', 'emergency', 'absent'].includes(v)) return 'critical';
    return '';
  }

  function status(label, cls) {
    return el('span', { class: `status ${cls ?? statusClass(label)}`, text: label || 'unknown' });
  }

  async function logout() {
    try {
      await api('POST', '/api/logout', {});
    } finally {
      location.href = '/login';
    }
  }

  // Overview · Services · Docs (Docs only when logged in: it always requires login)
  function viewTabs(active, loggedIn) {
    const tabs = [['overview', 'Overview', '/'], ['services', 'Services', '/services'], ...(loggedIn ? [['docs', 'Docs', '/docs']] : [])];
    return tabs.map(([key, label, href]) => el('a', { href, class: key === active ? 'active' : null, 'aria-current': key === active ? 'page' : null, text: label }));
  }

  // Integration values: { label, value, unit? }
  function statValue(st) {
    const v = st.value;
    if (v === null || v === undefined || v === '') return '–';
    if (typeof v === 'string') return v;
    switch (st.unit) {
      case 'B/s': return `${fmt.bytes(v)}/s`;
      case 'B': return fmt.bytes(v);
      case 'bps': return v >= 1e6 ? `${fmt.n(v / 1e6, 1)} Mbit/s` : `${fmt.n(v / 1e3, 0)} kbit/s`;
      case '%': return `${fmt.n(v, 1)} %`;
      case 'ms': return `${fmt.n(v, v < 10 ? 1 : 0)} ms`;
      case 'Mbps': return `${fmt.n(v, v < 10 ? 1 : 0)} Mbit/s`;
      default: return Number.isInteger(v) ? fmt.n(v) : fmt.n(v, 2);
    }
  }

  // Letter icon with a stable color per name
  function letterIcon(name, cls = 'svc-icon letter') {
    let hash = 0;
    for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const node = el('span', { class: cls, 'aria-hidden': 'true', text: String(name).trim().charAt(0).toUpperCase() || '?' });
    node.style.background = `hsl(${hash % 360} 55% 45%)`;
    return node;
  }

  // --- History sparklines ---
  // A slot is a placeholder in the page; fillSparks() fetches all slots' series in one request
  // (cached for a minute) and draws them. One series per graph: 2px line, light area, hover value.
  const RANGES = { '24h': '24 h', '7d': '7 d', '30d': '30 d' };
  const RANGE_MS = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
  let range = '24h';
  try {
    range = RANGES[localStorage.getItem('hd.range')] ? localStorage.getItem('hd.range') : '24h';
  } catch {
    /* storage unavailable */
  }
  let cache = { range: null, at: 0, series: {} };

  function sparkSlot(key, { label = '', unit = '', decimals = 0 } = {}) {
    return el('div', { class: 'spark-cell' },
      label ? el('div', { class: 'spark-label', text: label }) : null,
      el('div', { class: 'spark-slot', 'data-key': key, 'data-unit': unit, 'data-dec': decimals, 'data-label': label }));
  }

  const fmtVal = (v, unit, dec) => `${nf(dec).format(v)}${unit}`;

  function drawSpark(slot, points) {
    const unit = slot.dataset.unit;
    const dec = Number(slot.dataset.dec);
    if (!points || points.length < 2) return slot.replaceChildren(el('span', { class: 'spark-empty', text: 'Collecting history…' }));
    const W = 300;
    const H = 40;
    // The x axis is the whole range, so a series that started recently fills only the right part
    const t1 = Date.now();
    const t0 = Math.min(points[0][0], t1 - RANGE_MS[range]);
    const vs = points.map((p) => p[1]);
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
    const y = (v) => H - 3 - ((v - lo) / (hi - lo)) * (H - 6);
    const line = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const marker = svg('line', { class: 'spark-marker', x1: 0, x2: 0, y1: 0, y2: H, 'vector-effect': 'non-scaling-stroke' });
    marker.style.display = 'none';
    const graph = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      svg('path', { class: 'spark-area', d: `${line}L${x(points[points.length - 1][0]).toFixed(1)},${H}L${x(points[0][0]).toFixed(1)},${H}Z` }),
      svg('path', { class: 'spark-line', d: line, 'vector-effect': 'non-scaling-stroke' }),
      marker);
    const tip = el('div', { class: 'tooltip spark-tip hidden' });
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const last = vs[vs.length - 1];
    const span = `${RANGES[range]}: ${fmtVal(min, unit, dec)} – ${fmtVal(max, unit, dec)}`;
    const box = el('div', { class: 'spark', role: 'img', 'aria-label': `${slot.dataset.label || 'History'}, last ${RANGES[range]}: lowest ${fmtVal(min, unit, dec)}, highest ${fmtVal(max, unit, dec)}, now ${fmtVal(last, unit, dec)}` }, graph, tip);
    const show = (clientX) => {
      const r = box.getBoundingClientRect();
      const t = t0 + ((clientX - r.left) / r.width) * (t1 - t0);
      let best = 0;
      for (let i = 1; i < points.length; i++) if (Math.abs(points[i][0] - t) < Math.abs(points[best][0] - t)) best = i;
      const [bt, bv] = points[best];
      marker.setAttribute('x1', x(bt));
      marker.setAttribute('x2', x(bt));
      marker.style.display = '';
      tip.replaceChildren(el('strong', { text: fmtVal(bv, unit, dec) }), ` ${new Date(bt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', ...(range !== '24h' ? { day: 'numeric', month: 'short' } : {}) })}`);
      tip.classList.remove('hidden');
      const px = (x(bt) / W) * r.width;
      tip.style.left = `${Math.min(Math.max(px - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth)}px`;
    };
    box.addEventListener('pointermove', (e) => show(e.clientX));
    box.addEventListener('pointerdown', (e) => show(e.clientX));
    box.addEventListener('pointerleave', () => {
      tip.classList.add('hidden');
      marker.style.display = 'none';
    });
    slot.replaceChildren(box, el('div', { class: 'spark-range', text: span }));
  }

  async function fillSparks(force = false) {
    const slots = [...document.querySelectorAll('.spark-slot')];
    if (!slots.length) return;
    const keys = [...new Set(slots.map((s) => s.dataset.key))];
    const draw = () => {
      for (const s of document.querySelectorAll('.spark-slot')) if (cache.range === range && s.dataset.key in cache.series) drawSpark(s, cache.series[s.dataset.key]);
    };
    draw(); // from cache right away, so a re-render doesn't flicker
    const stale = force || cache.range !== range || Date.now() - cache.at > 60000 || keys.some((k) => !(k in cache.series));
    if (stale) {
      try {
        const r = await fetch(`/api/history?range=${range}&points=120&keys=${encodeURIComponent(keys.join(','))}`, { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) {
          const got = (await r.json()).series;
          cache = { range, at: Date.now(), series: { ...(cache.range === range ? cache.series : {}), ...Object.fromEntries(keys.map((k) => [k, got[k] || []])) } };
        }
      } catch {
        /* keep what we have */
      }
    }
    draw();
  }

  function rangeTabs(onChange) {
    return el('div', { class: 'range-tabs', role: 'group', 'aria-label': 'History range' }, Object.entries(RANGES).map(([k, label]) => el('button', {
      type: 'button',
      'aria-pressed': String(k === range),
      text: label,
      onclick: (e) => {
        range = k;
        try {
          localStorage.setItem('hd.range', k);
        } catch {
          /* fine */
        }
        for (const b of e.target.parentElement.children) b.setAttribute('aria-pressed', String(b === e.target));
        fillSparks(true);
        if (onChange) onChange(k);
      },
    })));
  }

  // --- Drag to rearrange ---
  // Moves `node` with the pointer and leaves a placeholder where it would land; `place(x, y, ph)`
  // moves the placeholder, `done(node)` runs after the drop. A click without movement is not a drag.
  function dragMove(e, node, { placeholderClass, place, done, maxHeight = 0 }) {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let ph = null;
    let rect = null;
    const begin = () => {
      rect = node.getBoundingClientRect();
      ph = el('div', { class: placeholderClass });
      ph.style.height = `${maxHeight ? Math.min(rect.height, maxHeight) : rect.height}px`;
      node.replaceWith(ph);
      document.body.append(node);
      node.classList.add('drag-ghost');
      node.style.width = `${rect.width}px`;
      if (maxHeight) node.style.maxHeight = `${maxHeight}px`;
    };
    const onMove = (ev) => {
      if (!ph) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        begin();
      }
      ev.preventDefault();
      node.style.left = `${rect.left + ev.clientX - startX}px`;
      node.style.top = `${rect.top + ev.clientY - startY}px`;
      place(ev.clientX, ev.clientY, ph);
      if (ev.clientY < 40) scrollBy(0, -12);
      else if (ev.clientY > innerHeight - 40) scrollBy(0, 12);
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      if (!ph) return;
      node.classList.remove('drag-ghost');
      for (const prop of ['left', 'top', 'width', 'max-height']) node.style.removeProperty(prop);
      ph.replaceWith(node);
      if (done) done(node);
    };
    addEventListener('pointermove', onMove, { passive: false });
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  }

  return { api, upload, raw, saveBlob, session, el, svg, fmt, status, statusClass, logout, viewTabs, statValue, letterIcon, sparkSlot, fillSparks, rangeTabs, dragMove };
})();
