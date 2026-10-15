'use strict';
// The first admin account: the setup code from the server's log, a user name and a password

document.getElementById('setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const err = document.getElementById('setup-error');
  const btn = ev.target.querySelector('button');
  err.textContent = '';
  if (f.password.value !== f.password2.value) {
    err.textContent = 'The passwords do not match';
    return;
  }
  btn.disabled = true;
  try {
    const r = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code: f.code.value, username: f.username.value.trim(), password: f.password.value, password2: f.password2.value }),
    });
    if (r.ok) {
      location.href = '/admin';
      return;
    }
    const data = await r.json().catch(() => ({}));
    if (r.status === 404 || r.status === 409) {
      location.href = '/login';
      return;
    }
    err.textContent = data.error || `Setup failed (HTTP ${r.status})`;
  } catch {
    err.textContent = 'Network error';
  } finally {
    btn.disabled = false;
  }
});
