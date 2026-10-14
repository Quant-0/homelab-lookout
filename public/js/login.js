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
      body: JSON.stringify({ username: document.getElementById('username').value, password: pw.value, keep: document.getElementById('keep').checked, remember: document.getElementById('remember').checked }),
    });
    if (r.ok) {
      // Only fixed, same-site destinations: no open redirects.
      const pages = { admin: '/admin', services: '/services', docs: '/docs', updates: '/updates', log: '/log', energy: '/energy', wall: '/wall', guide: '/guide.pdf', vms: '/vms', report: '/report' };
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

// Passkeys: a button where this dashboard's address has one, a pointer to it elsewhere
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)),
};
const goNext = () => {
  const pages = { admin: '/admin', services: '/services', docs: '/docs', updates: '/updates', log: '/log', energy: '/energy', wall: '/wall', guide: '/guide.pdf', vms: '/vms', report: '/report' };
  const next = new URLSearchParams(location.search).get('next');
  location.href = Object.hasOwn(pages, next) ? pages[next] : '/';
};
(async () => {
  if (!window.PublicKeyCredential || !window.isSecureContext && location.hostname !== 'localhost') return;
  const pk = await fetch('/api/passkey', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!pk?.available) return;
  if (!pk.here) {
    const p = document.getElementById('passkey-elsewhere');
    p.textContent = 'Passkeys work at ';
    const a = document.createElement('a');
    a.href = pk.url;
    a.textContent = pk.url.replace(/^https?:\/\//, '');
    p.append(a, '.');
    p.hidden = false;
    return;
  }
  const btn = document.getElementById('passkey');
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    const err = document.getElementById('login-error');
    err.textContent = '';
    btn.disabled = true;
    try {
      const o = await fetch('/api/passkey/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' });
      const opts = await o.json();
      if (!o.ok) throw new Error(opts.error || `HTTP ${o.status}`);
      const c = await navigator.credentials.get({ publicKey: { challenge: b64u.dec(opts.challenge), rpId: opts.rpId, timeout: opts.timeout, userVerification: opts.userVerification } });
      const r = c.response;
      const res = await fetch('/api/passkey/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ id: c.id, clientDataJSON: b64u.enc(r.clientDataJSON), authenticatorData: b64u.enc(r.authenticatorData), signature: b64u.enc(r.signature), userHandle: r.userHandle ? b64u.enc(r.userHandle) : null, keep: document.getElementById('keep').checked }),
      });
      if (res.ok) return goNext();
      const data = await res.json().catch(() => ({}));
      err.textContent = data.error || `Sign-in failed (HTTP ${res.status})`;
    } catch (e) {
      err.textContent = e?.name === 'NotAllowedError' ? 'Cancelled, or no passkey for this dashboard on this device' : e?.message || 'The passkey did not work';
    } finally {
      btn.disabled = false;
    }
  });
})();

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
