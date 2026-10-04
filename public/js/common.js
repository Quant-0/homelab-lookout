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

  // Lucide icons (icons.js), drawn in the current text colour
  function icon(name, cls = '') {
    const nodes = (typeof HD_ICONS !== 'undefined' && HD_ICONS[name]) || [];
    return svg('svg', { class: `icon ${cls}`.trim(), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
      nodes.map(([tag, attrs]) => svg(tag, attrs)));
  }

  // Status: icon + word, never colour alone
  const STATUS_ICONS = { good: 'circle-check', warning: 'triangle-alert', serious: 'triangle-alert', critical: 'octagon-alert', info: 'info' };
  function status(label, cls) {
    const c = cls ?? statusClass(label);
    return el('span', { class: `status ${c}`.trim() }, icon(STATUS_ICONS[c] || 'circle-dashed'), el('span', { text: label || 'unknown' }));
  }

  async function logout() {
    try {
      await api('POST', '/api/logout', {});
    } finally {
      location.href = '/login';
    }
  }

  // --- App shell: a sidebar on wide screens, a tab bar at the bottom on phones ---
  // Docs and Updates need a login or a remembered device; Admin always asks for the password.
  const NAV = [
    { key: 'overview', label: 'Overview', href: '/', icon: 'layout-dashboard' },
    { key: 'services', label: 'Services', href: '/services', icon: 'layout-grid' },
    { key: 'energy', label: 'Energy', href: '/energy', icon: 'zap' },
    { key: 'docs', label: 'Docs', href: '/docs', icon: 'book-open', signed: true },
    { key: 'updates', label: 'Updates', href: '/updates', icon: 'circle-arrow-up', signed: true },
  ];
  let shellState = { active: null, title: 'Homelab', admin: false, viewer: false, updates: 0 };
  let userName = null;

  // opts: { active, title, admin (logged in), viewer (remembered device), updates (count) }
  function shell(opts = {}) {
    shellState = { ...shellState, ...opts };
    const st = shellState;
    const signed = st.admin || st.viewer;
    const side = document.getElementById('sidebar');
    const bar = document.getElementById('tabbar');
    const navLink = (n, cls) => el('a', { class: `${cls}${n.key === st.active ? ' active' : ''}`, href: n.href, 'aria-current': n.key === st.active ? 'page' : null, title: n.label },
      icon(n.icon), el('span', { class: 'label', text: n.label }),
      n.key === 'updates' && st.updates ? el('span', { class: 'nav-badge num', text: String(st.updates), title: `${st.updates} available` }) : null);
    const items = NAV.filter((n) => !n.signed || signed);
    const admin = { key: 'admin', label: 'Admin', href: st.admin ? '/admin' : '/login?next=admin', icon: 'settings' };
    const next = st.active && st.active !== 'overview' && st.active !== 'admin' ? `?next=${st.active}` : '';
    if (side) {
      side.replaceChildren(
        el('a', { class: 'brand', href: '/', title: st.title }, el('img', { src: '/static/favicon.svg', alt: '' }), el('span', { class: 'label brand-name', text: st.title })),
        el('button', { type: 'button', class: 'search-button', title: 'Search (Ctrl K or /)', 'aria-keyshortcuts': 'Control+K', onclick: openSearch },
          icon('search'), el('span', { class: 'label', text: 'Search' }), el('kbd', { class: 'label', text: 'Ctrl K' })),
        el('div', { class: 'nav-list' }, items.map((n) => navLink(n, 'nav-item'))),
        el('div', { class: 'nav-foot' },
          signed ? navLink(admin, 'nav-item') : null,
          signed
            ? el('div', { class: 'user-row' },
              el('span', { class: 'avatar', 'aria-hidden': 'true', text: (userName || (st.viewer ? 'V' : 'A')).charAt(0).toUpperCase() }),
              el('span', { class: 'label user-text' }, el('strong', { text: userName || (st.viewer ? 'This device' : 'Admin') }), el('small', { text: st.viewer ? 'View only' : 'Administrator' })),
              el('button', { type: 'button', class: 'icon-button label', title: 'Log out', 'aria-label': 'Log out', onclick: logout }, icon('log-out')))
            : el('a', { class: 'nav-item', href: `/login${next}` }, icon('log-in'), el('span', { class: 'label', text: 'Log in' }))));
    }
    if (bar) {
      const tabs = NAV.filter((n) => !n.signed || (signed && n.key === 'docs'));
      const more = el('button', { type: 'button', class: `tab${['updates', 'admin'].includes(st.active) ? ' active' : ''}`, 'aria-haspopup': 'dialog', onclick: openMore },
        icon('ellipsis'), el('span', { class: 'label', text: 'More' }), st.updates && signed ? el('span', { class: 'nav-badge num', text: String(st.updates) }) : null);
      bar.replaceChildren(...tabs.map((n) => navLink(n, 'tab')), more);
    }
    // Phones: the logo and a search button in the page header
    const top = document.querySelector('.topbar');
    if (top && !top.querySelector('.topbar-logo')) {
      top.prepend(el('a', { class: 'topbar-logo', href: '/', 'aria-label': 'Overview' }, el('img', { src: '/static/favicon.svg', alt: '' })));
      top.append(el('button', { type: 'button', class: 'icon-button topbar-search', title: 'Search', 'aria-label': 'Search', onclick: openSearch }, icon('search')));
    }
    if (signed && userName === null) {
      userName = '';
      session().then((x) => {
        userName = x?.user || '';
        if (userName) shell();
      }).catch(() => {});
    }
  }

  // Phones: Updates, Admin, Search and Log out in a sheet from the bottom
  function openMore() {
    const st = shellState;
    const signed = st.admin || st.viewer;
    const dlg = el('dialog', { class: 'sheet', 'aria-label': 'More' });
    const close = () => dlg.close();
    const row = (ic, label, attrs) => el(attrs.href ? 'a' : 'button', { class: 'sheet-item', ...(attrs.href ? {} : { type: 'button' }), ...attrs }, icon(ic), el('span', { text: label }));
    dlg.append(el('div', { class: 'sheet-body' },
      el('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
      signed ? row('circle-arrow-up', st.updates ? `Updates · ${st.updates} available` : 'Updates', { href: '/updates' }) : null,
      signed ? row('settings', 'Admin', { href: st.admin ? '/admin' : '/login?next=admin' }) : null,
      row('search', 'Search', { onclick: () => { close(); openSearch(); } }),
      signed ? row('log-out', 'Log out', { onclick: logout }) : row('log-in', 'Log in', { href: '/login' })));
    dlg.addEventListener('click', (e) => e.target === dlg && close());
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // A button with an icon (and a label that hides on phones when `compact`)
  function iconButton(name, label, attrs = {}, compact = true) {
    const { href, class: cls, ...rest } = attrs;
    const node = href ? el('a', { class: `button ${cls || ''}`.trim(), href, ...rest }) : el('button', { type: 'button', class: cls, ...rest });
    if (!node.title) node.title = label;
    node.append(icon(name), el('span', { class: compact ? 'btn-label' : null, text: label }));
    return node;
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

  // Hidden until there is something to draw: no "collecting history" placeholders
  function sparkSlot(key, { label = '', unit = '', decimals = 0 } = {}) {
    return el('div', { class: 'spark-cell', hidden: true },
      label ? el('div', { class: 'spark-label', text: label }) : null,
      el('div', { class: 'spark-slot', 'data-key': key, 'data-unit': unit, 'data-dec': decimals, 'data-label': label }));
  }

  const fmtVal = (v, unit, dec) => `${nf(dec).format(v)}${unit}`;

  function drawSpark(slot, points) {
    const unit = slot.dataset.unit;
    const dec = Number(slot.dataset.dec);
    const cell = slot.closest('.spark-cell');
    const group = slot.closest('.sparks');
    if (cell) cell.hidden = !points || points.length < 2;
    if (group) group.hidden = ![...group.querySelectorAll('.spark-cell')].some((c) => !c.hidden);
    if (!points || points.length < 2) return slot.replaceChildren();
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

  // Long texts (e.g. NAS alerts) show three lines with a button for the rest
  function clampText(text, cls = '') {
    const box = el('div', { class: `clamp ${cls}`.trim(), text });
    if (String(text).length < 180) return box;
    box.classList.add('clamped');
    const more = el('button', { type: 'button', class: 'link-button', text: 'Show all', 'aria-expanded': 'false' });
    more.addEventListener('click', () => {
      const open = box.classList.toggle('clamped') === false;
      more.textContent = open ? 'Show less' : 'Show all';
      more.setAttribute('aria-expanded', String(open));
    });
    return el('div', null, box, more);
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

  // --- Search (Ctrl K or /): services, VMs, devices, docs and settings in one list ---
  // Built from the same APIs the pages use, so it only finds what you may see: docs and settings
  // appear only when you're logged in.
  let searchCache = null;
  async function searchItems() {
    if (searchCache && Date.now() - searchCache.at < 60000) return searchCache.items;
    const get = async (p) => {
      try {
        const r = await fetch(p, { credentials: 'same-origin', cache: 'no-store' });
        return r.ok ? r.json() : null;
      } catch {
        return null;
      }
    };
    const [svc, dash, docs] = await Promise.all([get('/api/services'), get('/api/dashboard'), get('/api/docs')]);
    const items = [];
    for (const g of svc?.groups || []) {
      for (const x of g.services || []) items.push({ kind: 'Service', title: x.name, sub: [g.name, x.description].filter(Boolean).join(' · '), href: x.href || '/services', external: Boolean(x.href), words: [g.name, x.description, x.integration].join(' ') });
      for (const v of g.vms?.items || []) items.push({ kind: v.type === 'lxc' ? 'Container' : 'VM', title: v.name, sub: `${v.vmid} on ${v.node} · ${v.status}`, href: '/services#vms', words: `${v.vmid} ${v.node}` });
    }
    for (const d of dash?.devices || []) items.push({ kind: 'Device', title: d.name, sub: 'On the Overview', href: `/#device-${d.id}`, words: d.kind });
    if (dash) items.push({ kind: 'Page', title: 'Energy report', sub: 'Power & cost per month and year', href: '/energy', words: 'kwh cost csv excel export power' });
    if (docs) {
      for (const d of docs.auto.devices) items.push({ kind: 'Docs', title: `${d.name} sheet`, sub: [d.model, ...d.ips].filter(Boolean).join(' · '), href: `/docs#server/${d.id}`, words: [d.name, d.model, d.serviceTag, d.hostName, ...d.ips].join(' ') });
      for (const p of docs.docs.pages) items.push({ kind: 'Page', title: p.title, sub: 'Docs', href: `/docs#page/${p.id}`, words: '', body: p.body });
      for (const r of docs.docs.network?.reservations || []) items.push({ kind: 'IP', title: `${r.ip}${r.name ? ` · ${r.name}` : ''}`, sub: 'Network plan', href: '/docs#network', words: r.name || '' });
      items.push({ kind: 'Page', title: 'Updates', sub: 'What can be updated', href: '/updates', words: 'versions firmware upgrade' });
      if (!docs.readOnly) for (const [tab, title, words] of [['devices', 'Devices and rack', 'panel connection idrac proxmox truenas synology unifi'], ['services', 'Services', 'integration icon'], ['alerts', 'Alerts', 'ntfy telegram discord e-mail notifications'],
        ['power', 'Power & cost', 'price tariff norgespris spot grid'], ['dashboard', 'Dashboard & look', 'title theme background public'], ['system', 'System', 'web server https port certificate backup password account']]) {
        items.push({ kind: 'Settings', title, sub: 'Admin', href: `/admin#${tab}`, words });
      }
    }
    searchCache = { at: Date.now(), items };
    return items;
  }

  function searchMatch(items, query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return items.filter((x) => x.kind === 'Service' || x.kind === 'Device').slice(0, 10);
    const out = [];
    for (const it of items) {
      const title = it.title.toLowerCase();
      const words = `${title} ${it.sub || ''} ${it.words || ''}`.toLowerCase();
      const body = (it.body || '').toLowerCase();
      if (!terms.every((t) => words.includes(t) || body.includes(t))) continue;
      let score = terms.every((t) => words.includes(t)) ? 2 : 0;
      if (title.startsWith(terms[0])) score += 3;
      else if (title.includes(terms[0])) score += 1;
      let snippet = null;
      if (!score && body) {
        const i = body.indexOf(terms.find((t) => body.includes(t)));
        snippet = `…${it.body.slice(Math.max(0, i - 30), i + 60).replace(/\s+/g, ' ')}…`;
      }
      out.push({ ...it, score, snippet });
    }
    return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, 12);
  }

  let searchDialog = null;
  function openSearch() {
    if (!searchDialog) {
      const input = el('input', { type: 'search', placeholder: 'Search services, devices, docs…', 'aria-label': 'Search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'search-results', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false' });
      const list = el('ul', { id: 'search-results', role: 'listbox', class: 'search-results', 'aria-label': 'Results' });
      const box = el('dialog', { class: 'search-dialog', 'aria-label': 'Search' },
        el('div', { class: 'search-box' }, input, list, el('p', { class: 'search-hint', text: '↑ ↓ to choose · Enter to open · Esc to close' })));
      document.body.append(box);
      let results = [];
      let active = 0;
      const go = (r) => {
        if (!r) return;
        box.close();
        if (r.external) window.open(r.href, '_blank', 'noopener,noreferrer');
        else location.href = r.href;
      };
      const draw = () => {
        list.replaceChildren(...results.map((r, i) => {
          const li = el('li', { id: `search-${i}`, role: 'option', 'aria-selected': String(i === active), class: i === active ? 'active' : null },
            el('span', { class: 'kind', text: r.kind }),
            el('span', { class: 'what' }, el('span', { class: 'title', text: r.title }), r.snippet || r.sub ? el('span', { class: 'sub', text: r.snippet || r.sub }) : null),
            r.external ? el('span', { class: 'ext', text: '↗', 'aria-label': 'opens in a new tab' }) : null);
          li.addEventListener('mousemove', () => {
            if (active !== i) {
              active = i;
              draw();
            }
          });
          li.addEventListener('click', () => go(r));
          return li;
        }));
        if (!results.length) list.append(el('li', { class: 'none', text: input.value.trim() ? 'Nothing found' : 'Nothing to search yet' }));
        input.setAttribute('aria-activedescendant', results.length ? `search-${active}` : '');
        list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
      };
      const update = async () => {
        const q = input.value;
        const found = searchMatch(await searchItems(), q);
        if (q !== input.value) return; // typed on meanwhile
        results = found;
        active = 0;
        draw();
      };
      input.addEventListener('input', update);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!results.length) return;
          active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
          draw();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          go(results[active]);
        } else if (e.key === 'Escape') {
          e.preventDefault(); // a search field would only clear its text on the first Esc
          box.close();
        }
      });
      box.addEventListener('click', (e) => e.target === box && box.close());
      searchDialog = { box, input, update };
    }
    searchDialog.input.value = '';
    searchDialog.box.showModal();
    searchDialog.input.focus();
    searchDialog.update();
  }

  function initSearch() {
    if (!document.getElementById('sidebar')) return;
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if ((e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        openSearch();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSearch);
  else initSearch();

  // The installable app's service worker (offline screen only; see sw.js)
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

  return { api, upload, raw, saveBlob, session, el, svg, icon, fmt, status, statusClass, logout, shell, iconButton, statValue, letterIcon, sparkSlot, fillSparks, rangeTabs, dragMove, clampText, openSearch };
})();
