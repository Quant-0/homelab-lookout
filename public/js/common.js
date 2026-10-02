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

  return { api, upload, session, el, svg, fmt, status, statusClass, logout, viewTabs, statValue, letterIcon };
})();
