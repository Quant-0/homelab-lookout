'use strict';

document.getElementById('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = document.getElementById('login-error');
  const btn = ev.target.querySelector('button');
  const pw = document.getElementById('password');
  err.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: document.getElementById('username').value, password: pw.value, remember: document.getElementById('remember').checked }),
    });
    if (r.ok) {
      // Only fixed, same-site destinations: no open redirects.
      const pages = { admin: '/admin', services: '/services', docs: '/docs', updates: '/updates', log: '/log', energy: '/energy', wall: '/wall', guide: '/guide.pdf', vms: '/vms' };
      const next = new URLSearchParams(location.search).get('next');
      location.href = Object.hasOwn(pages, next) ? pages[next] : '/';
      return;
    }
    const data = await r.json().catch(() => ({}));
    err.textContent = data.error || `Sign-in failed (HTTP ${r.status})`;
  } catch {
    err.textContent = 'Network error';
  } finally {
    pw.value = '';
    btn.disabled = false;
  }
});

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
