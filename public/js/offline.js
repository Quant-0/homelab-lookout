'use strict';
// Offline screen of the installed app: reload as soon as the dashboard answers again.

const msg = document.getElementById('offline-msg');
const btn = document.getElementById('retry');

// The manifest is public, tiny and never cached by the service worker: a real reachability check
async function reachable() {
  try {
    const r = await fetch('/manifest.webmanifest', { cache: 'no-store', credentials: 'omit' });
    return r.ok;
  } catch {
    return false;
  }
}

async function retry(manual) {
  btn.disabled = true;
  if (manual) msg.textContent = 'Trying…';
  if (await reachable()) return location.reload();
  btn.disabled = false;
  if (manual) msg.textContent = `Still no answer (${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}).`;
}

btn.addEventListener('click', () => retry(true));
window.addEventListener('online', () => retry(false));
setInterval(() => document.visibilityState === 'visible' && retry(false), 15000);
