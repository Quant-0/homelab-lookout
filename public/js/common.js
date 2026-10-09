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

  // --- App shell: a bar at the top on wide screens, a tab bar at the bottom on phones ---
  // Docs and Updates need a login or a remembered device; Admin always asks for the password.
  const NAV = [
    { key: 'overview', label: 'Home', href: '/', icon: 'house' },
    { key: 'rack', label: 'Rack', href: '/#rack', icon: 'server', rack: true },
    { key: 'services', label: 'Services', href: '/services', icon: 'layout-grid' },
    { key: 'energy', label: 'Energy', href: '/energy', icon: 'zap' },
    { key: 'docs', label: 'Docs', href: '/docs', icon: 'book-open', signed: true },
    { key: 'updates', label: 'Updates', href: '/updates', icon: 'circle-arrow-up', signed: true },
    { key: 'log', label: 'Log', href: '/log', icon: 'list', admin: true },
  ];
  let shellState = { active: null, title: 'Homelab', admin: false, viewer: false, updates: 0, rack: true };
  let userName = null;

  // opts: { active, title, admin (logged in), viewer (remembered device), updates (count), rack (shown) }
  function shell(opts = {}) {
    shellState = { ...shellState, ...opts };
    const st = shellState;
    const signed = st.admin || st.viewer;
    const side = document.getElementById('sidebar');
    const bar = document.getElementById('tabbar');
    const navLink = (n, cls) => el('a', { class: `${cls}${n.key === st.active ? ' active' : ''}`, href: n.href, 'aria-current': n.key === st.active ? 'page' : null, title: n.label },
      icon(n.icon), el('span', { class: 'label', text: n.label }),
      n.key === 'updates' && st.updates ? el('span', { class: 'nav-badge num', text: String(st.updates), title: `${st.updates} available` }) : null);
    const items = NAV.filter((n) => (!n.signed || signed) && (!n.admin || st.admin) && (!n.rack || st.rack));
    const admin = { key: 'admin', label: 'Admin', href: st.admin ? '/admin' : '/login?next=admin', icon: 'settings' };
    const next = st.active && st.active !== 'overview' && st.active !== 'admin' ? `?next=${st.active}` : '';
    if (side) {
      side.setAttribute('aria-label', 'Main');
      side.replaceChildren(
        el('a', { class: 'brand', href: '/', title: st.title }, el('img', { src: '/logo', alt: '' }), el('span', { class: 'brand-name', text: st.title })),
        el('div', { class: 'nav-list' }, items.map((n) => navLink(n, 'nav-item'))),
        el('div', { class: 'nav-foot' },
          el('button', { type: 'button', class: 'search-button', title: 'Search (Ctrl K or /)', 'aria-label': 'Search', 'aria-keyshortcuts': 'Control+K', onclick: openSearch },
            icon('search'), el('span', { class: 'label', text: 'Search' }), el('kbd', { text: navigator.platform?.startsWith('Mac') ? '⌘K' : 'Ctrl K' })),
          el('button', { type: 'button', class: 'icon-button look-button', title: 'Look on this device', 'aria-label': 'Look on this device', 'aria-haspopup': 'dialog', onclick: (e) => openLook(e.currentTarget) }, icon('palette')),
          signed ? navLink(admin, 'nav-item') : null,
          signed
            ? el('div', { class: 'user-row' },
              el('span', { class: 'avatar', title: `${userName || (st.viewer ? 'This device' : 'Admin')} · ${st.viewer ? 'view only' : 'administrator'}`, text: (userName || (st.viewer ? 'V' : 'A')).charAt(0).toUpperCase() }),
              el('span', { class: 'label user-text' }, el('strong', { text: userName || (st.viewer ? 'This device' : 'Admin') }), el('small', { text: st.viewer ? 'View only' : 'Administrator' })),
              el('button', { type: 'button', class: 'icon-button label', title: 'Log out', 'aria-label': 'Log out', onclick: logout }, icon('log-out')))
            : el('a', { class: 'nav-item', href: `/login${next}` }, icon('log-in'), el('span', { class: 'label', text: 'Log in' }))));
    }
    if (bar) {
      const tabs = items.filter((n) => ['overview', 'rack', 'services', 'energy'].includes(n.key));
      const more = el('button', { type: 'button', class: `tab${['docs', 'updates', 'log', 'admin'].includes(st.active) ? ' active' : ''}`, 'aria-haspopup': 'dialog', onclick: openMore },
        icon('ellipsis'), el('span', { class: 'label', text: 'More' }), st.updates && signed ? el('span', { class: 'nav-badge num', text: String(st.updates) }) : null);
      bar.replaceChildren(...tabs.map((n) => navLink(n, 'tab')), more);
    }
    if (signed && userName === null) {
      userName = '';
      session().then((x) => {
        userName = x?.user || '';
        if (userName) shell();
      }).catch(() => {});
    }
  }

  // Phones: Docs, Updates, Wall, Admin and Log out in a sheet from the bottom
  function openMore() {
    const st = shellState;
    const signed = st.admin || st.viewer;
    const dlg = el('dialog', { class: 'sheet', 'aria-label': 'More' });
    const close = () => dlg.close();
    const row = (ic, label, attrs) => el(attrs.href ? 'a' : 'button', { class: 'sheet-item', ...(attrs.href ? {} : { type: 'button' }), ...attrs }, icon(ic), el('span', { text: label }));
    dlg.append(el('div', { class: 'sheet-body' },
      el('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
      signed ? row('book-open', 'Docs', { href: '/docs' }) : null,
      signed ? row('circle-arrow-up', st.updates ? `Updates · ${st.updates} available` : 'Updates', { href: '/updates' }) : null,
      st.admin ? row('list', 'Log', { href: '/log' }) : null,
      row('tv', 'Wall display', { href: '/wall' }),
      row('palette', 'Look on this device', { onclick: () => { close(); openLook(null); } }),
      signed ? row('settings', 'Admin', { href: st.admin ? '/admin' : '/login?next=admin' }) : null,
      signed ? row('log-out', 'Log out', { onclick: logout }) : row('log-in', 'Log in', { href: '/login' })));
    dlg.addEventListener('click', (e) => e.target === dlg && close());
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // --- Look on this device: theme and accent over the owner's default (see look.js) ---
  const ACCENT_NAMES = { theme: 'Theme colour', indigo: 'Indigo', blue: 'Blue', teal: 'Teal', green: 'Green', amber: 'Amber', pink: 'Pink', red: 'Red', graphite: 'Graphite' };
  function openLook(anchor) {
    if (typeof HD_LOOK === 'undefined') return;
    document.querySelector('.look-menu')?.remove();
    const dlg = el('dialog', { class: 'look-menu', 'aria-label': 'Look on this device' });
    const draw = () => {
      const own = HD_LOOK.read();
      const theme = own.theme || HD_LOOK.owner.theme;
      const accent = own.accent || HD_LOOK.owner.accent;
      const basic = ['auto', 'dark', 'light'];
      const themes = el('select', { 'aria-label': 'Theme' }, Object.entries(HD_LOOK.THEMES).filter(([k]) => !basic.includes(k)).map(([k, l]) => el('option', { value: k, text: l })));
      themes.prepend(el('option', { value: '', text: 'More themes…' }));
      themes.value = basic.includes(theme) ? '' : theme;
      themes.addEventListener('change', () => themes.value && pick({ theme: themes.value }));
      dlg.replaceChildren(...[
        el('h4', { text: 'Appearance' }),
        el('div', { class: 'seg', role: 'group', 'aria-label': 'Light or dark' }, basic.map((k) => el('button', { type: 'button', 'aria-pressed': String(theme === k), text: HD_LOOK.THEMES[k], onclick: () => pick({ theme: k }) }))),
        themes,
        el('h4', { text: 'Accent' }),
        el('div', { class: 'swatches-row', role: 'group', 'aria-label': 'Accent' }, Object.keys(HD_LOOK.ACCENTS).map((k) => {
          const b = el('button', { type: 'button', class: `swatch${k === 'theme' ? ' theme' : ''}`, title: ACCENT_NAMES[k], 'aria-label': ACCENT_NAMES[k], 'aria-pressed': String(accent === k), onclick: () => pick({ accent: k }) });
          if (HD_LOOK.ACCENTS[k]) b.style.setProperty('--c', `light-dark(${HD_LOOK.ACCENTS[k][0]}, ${HD_LOOK.ACCENTS[k][1]})`);
          return b;
        })),
        el('p', { text: own.theme || own.accent ? 'Only on this device. Everyone else sees the owner’s choice.' : 'This is the owner’s choice. What you pick here stays on this device.' }),
        own.theme || own.accent ? el('button', { type: 'button', class: 'link-button', text: 'Use the owner’s look', onclick: () => pick({ theme: null, accent: null }) }) : null].filter(Boolean));
    };
    const pick = (next) => {
      HD_LOOK.save(next);
      draw();
      document.dispatchEvent(new CustomEvent('hd:look'));
    };
    draw();
    document.body.append(dlg);
    dlg.show();
    const r = anchor?.getBoundingClientRect();
    if (r) {
      dlg.style.top = `${Math.min(r.bottom + 8, innerHeight - dlg.offsetHeight - 8)}px`;
      dlg.style.left = `${Math.max(8, Math.min(r.right - dlg.offsetWidth, innerWidth - dlg.offsetWidth - 8))}px`;
    } else {
      dlg.style.left = `${Math.max(8, (innerWidth - dlg.offsetWidth) / 2)}px`;
      dlg.style.top = `${Math.max(8, innerHeight - dlg.offsetHeight - 96)}px`;
    }
    const outside = (e) => {
      if (!dlg.contains(e.target) && e.target !== anchor && !anchor?.contains(e.target)) close();
    };
    const esc = (e) => e.key === 'Escape' && close();
    const close = () => {
      dlg.remove();
      removeEventListener('pointerdown', outside, true);
      removeEventListener('keydown', esc);
      anchor?.focus();
    };
    setTimeout(() => addEventListener('pointerdown', outside, true), 0);
    addEventListener('keydown', esc);
    dlg.querySelector('button')?.focus();
  }

  // --- Details drawer: from the right on wide screens, a sheet from the bottom on phones ---
  // `content` is a node; `onClose` runs once when it closes. Returns { dialog, close }.
  function drawer(title, content, { onClose } = {}) {
    document.querySelector('dialog.drawer')?.close();
    const dlg = el('dialog', { class: 'drawer', 'aria-label': title });
    const close = () => dlg.close();
    dlg.append(
      el('div', { class: 'drawer-top' },
        el('span', { class: 'drawer-title', text: title }),
        el('button', { type: 'button', class: 'icon-button', title: 'Close', 'aria-label': 'Close', onclick: close }, icon('x'))),
      el('div', { class: 'drawer-body' }, content));
    dlg.addEventListener('click', (e) => e.target === dlg && close());
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (onClose) onClose();
    });
    document.body.append(dlg);
    dlg.showModal();
    requestAnimationFrame(() => dlg.classList.add('open'));
    return { dialog: dlg, close };
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
      case 's': return fmt.uptime(v);
      case 'min': return `${fmt.n(v)} min`;
      case 'W': return `${fmt.n(v)} W`;
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
  // one cache per range: Home's 24 h cards and a details panel at 7 d are on the page together
  const caches = {};
  let sparkSeq = 0;
  const drawnKeys = new Set();

  // Hidden until there is something to draw: no "collecting history" placeholders.
  // `range` pins a graph (Home's cards are always the last 24 h); without it, it follows the range buttons.
  function sparkSlot(key, { label = '', unit = '', decimals = 0, range: fixed = null } = {}) {
    return el('div', { class: 'spark-cell', hidden: true },
      label ? el('div', { class: 'spark-label', text: label }) : null,
      el('div', { class: 'spark-slot', 'data-key': key, 'data-unit': unit, 'data-dec': decimals, 'data-label': label, 'data-range': fixed || null }));
  }
  const rangeOf = (slot) => (RANGES[slot.dataset.range] ? slot.dataset.range : range);

  const fmtVal = (v, unit, dec) => `${nf(dec).format(v)}${unit}`;

  function drawSpark(slot, points, rng) {
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
    const t0 = Math.min(points[0][0], t1 - RANGE_MS[rng]);
    const vs = points.map((p) => p[1]);
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    // a steady value (an inlet at 21.8–22.1 °C) is drawn as a steady line, not zoomed into a wall
    const minSpan = Math.max(Math.abs(hi), Math.abs(lo)) * 0.1 || 1;
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
    const y = (v) => H - 3 - ((v - lo) / (hi - lo)) * (H - 6);
    // a smooth line: each step is a curve that leaves and arrives level, so it never overshoots
    const pts = points.map(([t, v]) => [x(t), y(v)]);
    const line = pts.map(([px, py], i) => {
      if (!i) return `M${px.toFixed(1)},${py.toFixed(1)}`;
      const [qx, qy] = pts[i - 1];
      const mx = ((qx + px) / 2).toFixed(1);
      return `C${mx},${qy.toFixed(1)} ${mx},${py.toFixed(1)} ${px.toFixed(1)},${py.toFixed(1)}`;
    }).join('');
    const gid = `sg${++sparkSeq}`;
    const marker = svg('line', { class: 'spark-marker', x1: 0, x2: 0, y1: 0, y2: H, 'vector-effect': 'non-scaling-stroke' });
    marker.style.display = 'none';
    // colours through the style object: the CSP allows that, but not style attributes
    const stops = [svg('stop', { offset: 0 }), svg('stop', { offset: 1 })];
    stops.forEach((st, i) => { st.style.stopColor = 'var(--line-c, var(--accent))'; st.style.stopOpacity = i ? '0' : '0.32'; });
    const fade = svg('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, ...stops);
    const area = svg('path', { class: 'spark-area', d: `${line}L${pts[pts.length - 1][0].toFixed(1)},${H}L${pts[0][0].toFixed(1)},${H}Z` });
    area.style.fill = `url(#${gid})`;
    const first = !drawnKeys.has(slot.dataset.key); // the line draws itself in once, not on every refresh
    drawnKeys.add(slot.dataset.key);
    const graph = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      svg('defs', null, fade),
      area,
      svg('path', { class: 'spark-glow', d: line, 'vector-effect': 'non-scaling-stroke' }),
      svg('path', { class: `spark-line${first ? ' drawn' : ''}`, d: line, 'vector-effect': 'non-scaling-stroke' }),
      marker);
    const end = el('span', { class: 'spark-end' });
    end.style.left = `${(pts[pts.length - 1][0] / W) * 100}%`;
    end.style.top = `${(pts[pts.length - 1][1] / H) * 100}%`;
    const tip = el('div', { class: 'tooltip spark-tip hidden' });
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const last = vs[vs.length - 1];
    const span = `${RANGES[rng]}: ${fmtVal(min, unit, dec)} – ${fmtVal(max, unit, dec)}`;
    const box = el('div', { class: 'spark', role: 'img', 'aria-label': `${slot.dataset.label || 'History'}, last ${RANGES[rng]}: lowest ${fmtVal(min, unit, dec)}, highest ${fmtVal(max, unit, dec)}, now ${fmtVal(last, unit, dec)}` }, graph, end, tip);
    const show = (clientX) => {
      const r = box.getBoundingClientRect();
      const t = t0 + ((clientX - r.left) / r.width) * (t1 - t0);
      let best = 0;
      for (let i = 1; i < points.length; i++) if (Math.abs(points[i][0] - t) < Math.abs(points[best][0] - t)) best = i;
      const [bt, bv] = points[best];
      marker.setAttribute('x1', x(bt));
      marker.setAttribute('x2', x(bt));
      marker.style.display = '';
      tip.replaceChildren(el('strong', { text: fmtVal(bv, unit, dec) }), ` ${new Date(bt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', ...(rng !== '24h' ? { day: 'numeric', month: 'short' } : {}) })}`);
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
    const draw = () => {
      for (const s of document.querySelectorAll('.spark-slot')) {
        const c = caches[rangeOf(s)];
        if (c && s.dataset.key in c.series) drawSpark(s, c.series[s.dataset.key], rangeOf(s));
      }
    };
    draw(); // from cache right away, so a re-render doesn't flicker
    const wanted = {};
    for (const s of slots) (wanted[rangeOf(s)] ||= new Set()).add(s.dataset.key);
    await Promise.all(Object.entries(wanted).map(async ([rng, set]) => {
      const keys = [...set];
      const c = caches[rng];
      if (!(force || !c || Date.now() - c.at > 60000 || keys.some((k) => !(k in c.series)))) return;
      try {
        const r = await fetch(`/api/history?range=${rng}&points=120&keys=${encodeURIComponent(keys.join(','))}`, { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) {
          const got = (await r.json()).series;
          caches[rng] = { at: Date.now(), series: { ...(caches[rng]?.series || {}), ...Object.fromEntries(keys.map((k) => [k, got[k] || []])) } };
        }
      } catch {
        /* keep what we have */
      }
    }));
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
    for (const d of dash?.devices || []) items.push({ kind: 'Device', title: d.name, sub: 'Device', href: `/#device-${d.id}`, words: d.kind });
    if (dash) items.push({ kind: 'Page', title: 'Energy report', sub: 'Power & cost per month and year', href: '/energy', words: 'kwh cost csv excel export power' });
    if (dash?.rack?.enabled) items.push({ kind: 'Page', title: 'Rack', sub: 'The rack, drawn to scale', href: '/#rack', words: 'front schematic units' });
    if (dash) items.push({ kind: 'Page', title: 'Wall display', sub: 'One screen for a tablet or TV', href: '/wall', words: 'kiosk tv tablet fullscreen' });
    if (docs) {
      for (const d of docs.auto.devices) items.push({ kind: 'Docs', title: `${d.name} sheet`, sub: [d.model, ...d.ips].filter(Boolean).join(' · '), href: `/docs#server/${d.id}`, words: [d.name, d.model, d.serviceTag, d.hostName, ...d.ips].join(' ') });
      for (const p of docs.docs.pages) items.push({ kind: 'Page', title: p.title, sub: 'Docs', href: `/docs#page/${p.id}`, words: '', body: p.body });
      for (const r of docs.docs.network?.reservations || []) items.push({ kind: 'IP', title: `${r.ip}${r.name ? ` · ${r.name}` : ''}`, sub: 'Network plan', href: '/docs#network', words: r.name || '' });
      items.push({ kind: 'Page', title: 'Updates', sub: 'What can be updated', href: '/updates', words: 'versions firmware upgrade' });
      if (!docs.readOnly) items.push({ kind: 'Page', title: 'Log', sub: 'Every change, problem and sign-in', href: '/log', words: 'history changes audit events ip timeline' });
      if (!docs.readOnly) for (const [tab, title, words] of [['devices', 'Devices and rack', 'panel connection catalog add device redfish idrac ilo xclarity supermicro proxmox truenas synology unifi snmp nut ups omada cisco mikrotik'], ['services', 'Services', 'integration icon'], ['alerts', 'Alerts', 'ntfy telegram discord e-mail notifications'],
        ['power', 'Power & cost', 'price tariff norgespris spot grid'], ['dashboard', 'Dashboard & look', 'title theme accent colour background public logo internet provider carrier isp'], ['system', 'System', 'web server https port certificate backup password account']]) {
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

  return { api, upload, raw, saveBlob, session, el, svg, icon, fmt, status, statusClass, logout, shell, openLook, drawer, iconButton, statValue, letterIcon, sparkSlot, fillSparks, rangeTabs, dragMove, clampText, openSearch };
})();
