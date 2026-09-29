// api.js — shared by all three BookMySpa websites:
//   customer site  (/)          — browse & book
//   partner portal (/partner/)  — spa owners manage their business
//   admin console  (/admin/)    — platform administration
// Each website keeps its own separate login session.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

const PORTAL = (() => {
  const host = location.hostname, path = location.pathname;
  if (host.startsWith('partner.') || path.startsWith('/partner')) return 'partner';
  if (host.startsWith('admin.') || path.startsWith('/admin')) return 'admin';
  return 'customer';
})();
const PORTAL_HOME = { customer: '/', partner: '/partner/', admin: '/admin/login.html' };
const PORTAL_LOGIN = { customer: '/login.html', partner: '/partner/login.html', admin: '/admin/login.html' };
const PORTAL_ROLE = { customer: 'customer', partner: 'owner', admin: 'admin' };
const TOKEN_KEY = `bms_${PORTAL}_token`;
const USER_KEY = `bms_${PORTAL}_user`;

const API = {
  base: '/api',
  token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  user() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } },
  isLoggedIn() { return !!this.token() && !!this.user(); },
  saveSession(token, user) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); },
  clearSession() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); },
  logout() { this.clearSession(); window.location.href = PORTAL_HOME[PORTAL]; },

  // Redirects to this website's login page unless a user with the right role is signed in.
  requireRole() {
    const u = this.user();
    if (!this.isLoggedIn() || !u || u.role !== PORTAL_ROLE[PORTAL]) {
      this.clearSession();
      window.location.href = PORTAL_LOGIN[PORTAL] + '?next=' + encodeURIComponent(location.pathname + location.search);
      return false;
    }
    return true;
  },

  async req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = this.token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    let res;
    try {
      res = await fetch(this.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Can't reach BookMySpa right now. Check your internet connection and try again.");
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && t) {
      // Session expired or invalid — sign out cleanly instead of leaving a broken page.
      this.clearSession();
      toast('Your session has expired. Please log in again.', 'error');
      setTimeout(() => { window.location.href = PORTAL_LOGIN[PORTAL]; }, 1200);
    }
    if (!res.ok) {
      const err = new Error(data.error || (res.status >= 500 ? 'Something went wrong on our side. Please try again.' : 'Request failed.'));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  },
  get(path) { return this.req('GET', path); },
  post(path, body) { return this.req('POST', path, body === undefined ? {} : body); },
  put(path, body) { return this.req('PUT', path, body === undefined ? {} : body); },
  del(path) { return this.req('DELETE', path); },
};

let _configPromise = null;
function getConfig() {
  if (!_configPromise) _configPromise = API.get('/config').catch(() => ({ onlinePayments: false, otp: false, partnerUrl: '/partner/' }));
  return _configPromise;
}

// Escape any text before inserting it into HTML (defense in depth alongside server-side sanitizing).
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }

// Local calendar date as YYYY-MM-DD (toISOString() would give the UTC date, wrong before 5:30am IST).
function localISODate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}
function formatTime(t) {
  if (!t || !/^\d{1,2}:\d{2}/.test(t)) return esc(t || '');
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function toast(msg, kind = 'info') {
  let el = document.getElementById('sb-toast');
  if (!el) { el = document.createElement('div'); el.id = 'sb-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'sb-toast show ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3600);
}

function renderNav(active) {
  const nav = document.getElementById('sb-nav');
  if (!nav) return;
  const user = API.user();
  const first = user ? esc(user.name.split(' ')[0]) : '';
  const brandHref = PORTAL === 'partner' ? '/partner/' : PORTAL === 'admin' ? '/admin/' : '/';
  const tag = PORTAL === 'partner' ? '<span class="portal-tag">Partner</span>' : PORTAL === 'admin' ? '<span class="portal-tag">Admin</span>' : '';
  let right = '';
  if (PORTAL === 'customer') {
    right = user
      ? `<a href="/account.html" class="nav-link ${active === 'account' ? 'active' : ''}">My bookings</a><span class="nav-user">Hi, ${first}</span><button class="nav-link as-link" onclick="API.logout()">Log out</button>`
      : `<a href="/login.html" class="nav-link">Log in</a><a href="/register.html" class="nav-btn">Sign up</a>`;
  } else if (PORTAL === 'partner') {
    right = user
      ? `<a href="/partner/dashboard.html" class="nav-link ${active === 'dashboard' ? 'active' : ''}">Dashboard</a><span class="nav-user">Hi, ${first}</span><button class="nav-link as-link" onclick="API.logout()">Log out</button>`
      : `<a href="/partner/login.html" class="nav-link">Partner login</a><a href="/partner/register.html" class="nav-btn">List your spa</a>`;
  } else {
    right = user ? `<span class="nav-user">Hi, ${first}</span><button class="nav-link as-link" onclick="API.logout()">Log out</button>` : '';
  }
  nav.innerHTML = `<div class="nav-inner"><a href="${brandHref}" class="brand"><span class="brand-mark">🌿</span> BookMySpa ${tag}</a><div class="nav-right">${right}</div></div>`;
}

async function renderFooter() {
  const footer = document.getElementById('sb-footer');
  if (!footer) return;
  const year = new Date().getFullYear();
  if (PORTAL === 'admin') { footer.innerHTML = `<div class="wrap footer-bottom">© ${year} BookMySpa · Admin console</div>`; return; }
  const cfg = await getConfig();
  const partnerUrl = esc(cfg.partnerUrl || '/partner/');
  const businessCol = PORTAL === 'partner'
    ? `<h5>Partners</h5><a href="/partner/register.html">List your spa</a><a href="/partner/login.html">Partner login</a><a href="/">Customer website</a>`
    : `<h5>For business</h5><a href="${partnerUrl}">Partner with us</a>`;
  footer.innerHTML = `
    <div class="wrap footer-inner">
      <div class="footer-col footer-brand">
        <div class="brand" style="color:var(--white)"><span class="brand-mark">🌿</span> BookMySpa</div>
        <p>${PORTAL === 'partner' ? 'Fill your empty slots, cut no-shows, and manage every booking in one place.' : 'Book massage and spa appointments online — browse nearby spas, compare prices, and pay securely.'}</p>
      </div>
      <div class="footer-col"><h5>Company</h5><a href="/about.html">About us</a><a href="/contact.html">Contact us</a></div>
      <div class="footer-col"><h5>Legal</h5><a href="/privacy.html">Privacy policy</a><a href="/terms.html">Terms of service</a></div>
      <div class="footer-col">${businessCol}</div>
    </div>
    <div class="wrap footer-bottom">© ${year} BookMySpa. All rights reserved.</div>`;
}
