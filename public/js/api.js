// api.js — shared fetch helper + session management for all pages

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
const API = {
  base: '/api',

  token() { return localStorage.getItem('sb_token'); },
  user() { try { return JSON.parse(localStorage.getItem('sb_user')); } catch { return null; } },
  isLoggedIn() { return !!this.token(); },

  saveSession(token, user) {
    localStorage.setItem('sb_token', token);
    localStorage.setItem('sb_user', JSON.stringify(user));
  },

  logout() {
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_user');
    window.location.href = '/';
  },

  async req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = this.token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  get(path) { return this.req('GET', path); },
  post(path, body) { return this.req('POST', path, body); },
  put(path, body) { return this.req('PUT', path, body); },
  del(path) { return this.req('DELETE', path); },
};

function money(n) {
  return '₹' + Number(n).toLocaleString('en-IN');
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function toast(msg, kind = 'info') {
  let el = document.getElementById('sb-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sb-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'sb-toast show ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// Renders the shared top nav into any element with id="sb-nav"
function renderNav(active) {
  const nav = document.getElementById('sb-nav');
  if (!nav) return;
  const user = API.user();

  let rightLinks = '';
  if (!user) {
    rightLinks = `<a href="/login.html" class="nav-link">Log in</a><a href="/register.html" class="nav-btn">Get started</a>`;
  } else if (user.role === 'customer') {
    rightLinks = `<a href="/account.html" class="nav-link ${active === 'account' ? 'active' : ''}">My bookings</a>
      <span class="nav-user">Hi, ${user.name.split(' ')[0]}</span>
      <button class="nav-link as-link" onclick="API.logout()">Log out</button>`;
  } else if (user.role === 'owner') {
    rightLinks = `<a href="/owner/index.html" class="nav-link ${active === 'owner' ? 'active' : ''}">Owner dashboard</a>
      <span class="nav-user">Hi, ${user.name.split(' ')[0]}</span>
      <button class="nav-link as-link" onclick="API.logout()">Log out</button>`;
  } else if (user.role === 'admin') {
    rightLinks = `<a href="/admin/index.html" class="nav-link ${active === 'admin' ? 'active' : ''}">Admin panel</a>
      <span class="nav-user">Hi, ${user.name.split(' ')[0]}</span>
      <button class="nav-link as-link" onclick="API.logout()">Log out</button>`;
  }

  nav.innerHTML = `
    <div class="nav-inner">
      <a href="/" class="brand"><span class="brand-mark">🌿</span> SpaBook</a>
      <div class="nav-right">${rightLinks}</div>
    </div>
  `;
}
