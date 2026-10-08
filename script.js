/* Harbor Card – all logic in one file.
   DEMO ONLY: data is stored in this browser's localStorage.
   Never use this approach for real card data or real passwords. */

/* ================= Settings ================= */
const CURRENCY = 'USD';               // change to 'INR', 'EUR', etc.
const OTP_SECONDS = 120;              // one-time code lifetime
const MAX_OTP_TRIES = 3;
const ONLINE_WINDOW_MS = 90 * 1000;   // "logged in" = seen within this time
const HASH_SALT = 'harbor-demo-salt';

const KEYS = {
  users: 'hc_users', txns: 'hc_transactions', active: 'hc_active_members',
  session: 'hc_session_user', admin: 'hc_session_admin', pending: 'hc_pending_payment'
};
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD_HASH = hashText('Harbor#Admin26');

/* ================= Helpers ================= */
const $ = id => document.getElementById(id);
function load(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
function save(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function sget(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch (e) { return null; } }
function sset(key, value) { sessionStorage.setItem(key, JSON.stringify(value)); }
function sdel(key) { sessionStorage.removeItem(key); }

function hashText(text) {
  const t = HASH_SALT + text;
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 31) ^ c; }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY });
function formatMoney(n) { return moneyFmt.format(n || 0); }
function pad(n) { return String(n).padStart(2, '0'); }
function dateString(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function timeString(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showMessage(el, text, type) { el.textContent = text; el.className = 'alert alert-' + (type || 'error'); el.hidden = false; }
function hideMessage(el) { el.hidden = true; }
function newOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
function makeCardNumber() {
  let d = '4';
  for (let i = 0; i < 14; i++) d += Math.floor(Math.random() * 10);
  let sum = 0;
  for (let i = 0; i < 15; i++) { let n = Number(d[14 - i]); if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  return d + ((10 - (sum % 10)) % 10);
}
function makeExpiry() { return pad(1 + Math.floor(Math.random() * 12)) + '/' + pad((new Date().getFullYear() + 3 + Math.floor(Math.random() * 3)) % 100); }
function makeTxnId(date) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let r = '';
  for (let i = 0; i < 5; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return 'TXN-' + dateString(date).replace(/-/g, '') + '-' + r;
}

/* ================= Users & sessions ================= */
function getUsers() { return load(KEYS.users, []); }
function findUser(name) { const u = String(name || '').trim().toLowerCase(); return getUsers().find(x => x.username.toLowerCase() === u) || null; }
function saveUser(user) {
  const users = getUsers(), i = users.findIndex(x => x.username === user.username);
  if (i >= 0) users[i] = user; else users.push(user);
  save(KEYS.users, users);
}
function registerUser(d) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(d.username)) return { error: 'Username must be 3–20 letters, numbers or underscores.' };
  if (findUser(d.username)) return { error: 'That username is already taken. Choose another.' };
  if (!d.holder.trim()) return { error: 'Enter the card holder name.' };
  if (d.password.length < 8) return { error: 'Login password must be at least 8 characters.' };
  if (d.payPassword.length < 6) return { error: 'Payment password must be at least 6 characters.' };
  if (d.payPassword === d.password) return { error: 'Payment password must be different from your login password.' };
  const user = {
    username: d.username, holder: d.holder.trim(), passwordHash: hashText(d.password), payHash: hashText(d.payPassword),
    limit: Number(d.limit) || 5000, cardNumber: makeCardNumber(), expiry: makeExpiry(),
    createdAt: Date.now(), lastLogin: null, previousLogin: null
  };
  saveUser(user);
  return { user };
}
function loginUser(username, password) {
  const user = findUser(username);
  if (!user || user.passwordHash !== hashText(password)) return null;
  user.previousLogin = user.lastLogin; user.lastLogin = Date.now(); saveUser(user);
  sset(KEYS.session, user.username); touchActive(user.username);
  return user;
}
function currentUser() { const n = sget(KEYS.session); return n ? findUser(n) : null; }
function touchActive(username) { const a = load(KEYS.active, {}); a[username] = Date.now(); save(KEYS.active, a); }
function onlineMembers() { const a = load(KEYS.active, {}); return Object.keys(a).filter(n => Date.now() - a[n] < ONLINE_WINDOW_MS); }
function logout() {
  const n = sget(KEYS.session);
  if (n) { const a = load(KEYS.active, {}); delete a[n]; save(KEYS.active, a); }
  sdel(KEYS.session); sdel(KEYS.pending); sdel(KEYS.admin);
  go('login');
}

/* ================= Transactions ================= */
function getTxns() { return load(KEYS.txns, []); }
function sortNewest(list) { return list.slice().sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)); }
function userTxns(username) { return sortNewest(getTxns().filter(t => t.username === username)); }
function createTxn(user, amount, description, status, when) {
  const d = when || new Date();
  const txn = { id: makeTxnId(d), username: user.username, holder: user.holder, description, amount: Number(amount), status, date: dateString(d), time: timeString(d) };
  const all = getTxns(); all.push(txn); save(KEYS.txns, all);
  return txn;
}
function getSummary(user) {
  const all = userTxns(user.username), ok = all.filter(t => t.status === 'Success');
  const spent = ok.reduce((s, t) => s + t.amount, 0);
  const monthKey = dateString(new Date()).slice(0, 7);
  return {
    limit: user.limit, spent, available: Math.max(0, user.limit - spent),
    usedPct: Math.min(100, Math.round((spent / user.limit) * 100)),
    month: ok.filter(t => t.date.startsWith(monthKey)).reduce((s, t) => s + t.amount, 0),
    average: ok.length ? spent / ok.length : 0,
    largest: ok.reduce((m, t) => Math.max(m, t.amount), 0),
    success: ok.length, notCompleted: all.length - ok.length
  };
}
function statusBadge(status) {
  const cls = status === 'Success' ? 'badge-ok' : status === 'Failed' ? 'badge-bad' : 'badge-warn';
  return '<span class="badge ' + cls + '">' + escapeHtml(status) + '</span>';
}

/* Demo data, created once on first visit */
function seedDemoData() {
  if (load(KEYS.users, null) !== null) return;
  const demo = { username: 'demo', holder: 'Demo Customer', passwordHash: hashText('Demo@1234'), payHash: hashText('Pay@5678'),
    limit: 5000, cardNumber: makeCardNumber(), expiry: makeExpiry(), createdAt: Date.now(), lastLogin: null, previousLogin: null };
  save(KEYS.users, [demo]);
  const ago = days => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(11, 20, 5); return d; };
  createTxn(demo, 82.40, 'Grocery store', 'Success', ago(3));
  createTxn(demo, 349.99, 'Electronics shop', 'Success', ago(9));
  createTxn(demo, 120.00, 'Online subscription', 'Failed', ago(12));
}

/* ================= Router & navigation ================= */
const VIEWS = {
  login: { auth: true }, adminlogin: { auth: true },
  dashboard: { role: 'user' }, payment: { role: 'user' }, otp: { role: 'user' },
  history: { role: 'user' }, security: { role: 'user' }, admin: { role: 'admin' }
};
let currentView = '';
let otpTimer = null;

function go(name, query) { location.hash = '#/' + name + (query ? '?' + query : ''); }

function renderNav(active, isAdmin) {
  const links = isAdmin
    ? [['admin', 'Admin Dashboard']]
    : [['dashboard', 'Dashboard'], ['payment', 'Process Payment'], ['history', 'Transaction History'], ['security', 'Security Center']];
  const user = isAdmin ? null : currentUser();
  $('nav').innerHTML =
    '<header class="topbar"><div class="topbar-inner">' +
    '<a class="brand" href="#/' + links[0][0] + '">Harbor Card</a>' +
    '<button class="nav-toggle" id="navToggle" aria-expanded="false" aria-controls="navLinks">Menu</button>' +
    '<nav id="navLinks" aria-label="Main">' +
    links.map(l => '<a href="#/' + l[0] + '"' + (l[0] === active ? ' class="active" aria-current="page"' : '') + '>' + l[1] + '</a>').join('') +
    '</nav><div class="who"><span id="navUser"></span><button class="btn btn-ghost" id="logoutBtn">Log out</button></div></div></header>';
  $('navUser').textContent = isAdmin ? 'Administrator' : (user ? user.username : '');
  $('logoutBtn').addEventListener('click', logout);
  $('navToggle').addEventListener('click', () => {
    const open = $('navLinks').classList.toggle('open');
    $('navToggle').setAttribute('aria-expanded', open);
  });
}

function route() {
  clearInterval(otpTimer);
  const raw = location.hash.replace(/^#\/?/, '') || 'login';
  const [name, query] = raw.split('?');
  const def = VIEWS[name];
  if (!def) return go('login');

  const user = currentUser(), isAdmin = !!sget(KEYS.admin);
  if (def.role === 'user' && !user) return go('login');
  if (def.role === 'admin' && !isAdmin) return go('adminlogin');
  if (name === 'login' && user) return go('dashboard');
  if (name === 'adminlogin' && isAdmin) return go('admin');

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
  currentView = name;
  window.scrollTo(0, 0);

  if (def.auth) { $('nav').innerHTML = ''; }
  else renderNav(name, def.role === 'admin');

  const params = new URLSearchParams(query || '');
  ({ login: showLogin, adminlogin: showAdminLogin, dashboard: showDashboard, payment: showPayment,
     otp: showOtp, history: () => showHistory(params), security: showSecurity, admin: showAdmin })[name](user);
}

/* ================= Views ================= */
function showLogin() {
  $('loginForm').reset(); $('registerForm').reset();
  hideMessage($('loginMsg')); hideMessage($('regMsg'));
}
function showAdminLogin() { $('adminForm').reset(); hideMessage($('adminMsg')); }

function showDashboard(user) {
  const s = getSummary(user);
  $('welcome').textContent = 'Welcome back, ' + user.username;
  $('ccAvail').textContent = formatMoney(s.available);
  $('ccNumber').textContent = '•••• •••• •••• ' + user.cardNumber.slice(-4);
  $('ccHolder').textContent = user.holder; $('ccExpiry').textContent = user.expiry;
  $('sLimit').textContent = formatMoney(s.limit); $('sSpent').textContent = formatMoney(s.spent);
  $('sMonth').textContent = formatMoney(s.month); $('sAvg').textContent = formatMoney(s.average);
  $('sLargest').textContent = formatMoney(s.largest);
  $('sCount').textContent = s.success + ' paid, ' + s.notCompleted + ' not completed';
  $('meter').setAttribute('aria-valuenow', s.usedPct);
  $('meterFill').style.width = '0';
  setTimeout(() => $('meterFill').style.width = s.usedPct + '%', 50);
  $('meterUsed').textContent = s.usedPct + '% of limit used';
  $('meterLeft').textContent = formatMoney(s.available) + ' left';
  const rows = userTxns(user.username).slice(0, 5);
  $('recentRows').innerHTML = rows.length ? rows.map(t =>
    '<tr><td>' + t.date + ' ' + t.time + '</td><td class="num">' + t.id + '</td><td>' + escapeHtml(t.description) +
    '</td><td class="right num">' + formatMoney(t.amount) + '</td><td>' + statusBadge(t.status) + '</td></tr>').join('')
    : '<tr><td colspan="5" class="empty">No transactions yet. <a href="#/payment">Make your first payment</a>.</td></tr>';
}

function showPayment(user) {
  $('payForm').reset(); hideMessage($('payMsg'));
  $('payAvail').textContent = formatMoney(getSummary(user).available);
  $('pHolder').value = user.holder;
  $('pCard').value = '•••• •••• •••• ' + user.cardNumber.slice(-4) + '  (expires ' + user.expiry + ')';
}

function showOtp(user) {
  const p = sget(KEYS.pending);
  if (!p || p.username !== user.username) return go('payment');
  hideMessage($('otpMsg')); $('oCode').value = '';
  $('oDesc').textContent = p.description; $('oAmt').textContent = formatMoney(p.amount);
  $('oDemo').textContent = p.otp;
  updateOtpTimer();
  otpTimer = setInterval(updateOtpTimer, 1000);
}
function updateOtpTimer() {
  const p = sget(KEYS.pending); if (!p) return;
  const left = Math.max(0, Math.ceil((p.expires - Date.now()) / 1000));
  $('oTimer').textContent = Math.floor(left / 60) + ':' + pad(left % 60);
  if (left === 0) finishPayment('Failed');   // code expired
}
function finishPayment(status) {
  const user = currentUser(), p = sget(KEYS.pending);
  clearInterval(otpTimer);
  if (!user || !p) return go('payment');
  const txn = createTxn(user, p.amount, p.description, status);
  sdel(KEYS.pending);
  go('history', 'result=' + status + '&id=' + txn.id);
}

function showHistory(params) {
  const user = currentUser();
  $('hSearch').value = ''; $('hFilter').value = '';
  drawHistory();
  const banner = $('histBanner'), result = params.get('result'), id = params.get('id');
  hideMessage(banner);
  if (result === 'Success') showMessage(banner, 'Payment successful. Transaction ID: ' + id, 'ok');
  else if (result === 'Failed') showMessage(banner, 'Payment failed: the code expired, was entered incorrectly too many times, or credit was insufficient. Transaction ID: ' + id, 'error');
  else if (result === 'Cancelled') showMessage(banner, 'Payment cancelled. Transaction ID: ' + id, 'info');
}
function drawHistory() {
  const user = currentUser(); if (!user) return;
  const all = userTxns(user.username);
  const q = $('hSearch').value.trim().toLowerCase(), f = $('hFilter').value;
  const list = all.filter(t => (!f || t.status === f) && (!q || t.id.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)));
  $('histRows').innerHTML = list.length ? list.map(t =>
    '<tr><td>' + t.date + '</td><td class="num">' + t.time + '</td><td class="num">' + t.id + '</td><td>' + escapeHtml(t.holder) +
    '</td><td>' + escapeHtml(t.description) + '</td><td class="right num">' + formatMoney(t.amount) + '</td><td>' + statusBadge(t.status) + '</td></tr>').join('')
    : '<tr><td colspan="7" class="empty">' + (all.length ? 'No transactions match your search.' : 'No transactions yet.') + '</td></tr>';
}

function showSecurity(user) {
  ['spForm', 'slForm'].forEach(id => $(id).reset());
  hideMessage($('spMsg')); hideMessage($('slMsg'));
  $('lastLogin').textContent = user.previousLogin
    ? 'Your previous sign-in was on ' + new Date(user.previousLogin).toLocaleString() + '.'
    : 'This is your first sign-in.';
}

function showAdmin() {
  const users = getUsers(), all = getTxns(), online = onlineMembers();
  $('aMembers').textContent = users.length; $('aOnline').textContent = online.length; $('aTxns').textContent = all.length;
  $('aMemberRows').innerHTML = users.map(u =>
    '<tr><td>' + escapeHtml(u.username) + '</td><td>' + escapeHtml(u.holder) + '</td><td class="right num">' + formatMoney(u.limit) + '</td><td>' +
    (online.includes(u.username) ? '<span class="badge badge-ok">Logged in</span>' : '<span class="badge badge-warn">Offline</span>') + '</td></tr>').join('');
  const latest = sortNewest(all).slice(0, 8);
  $('aTxnRows').innerHTML = latest.length ? latest.map(t =>
    '<tr><td>' + t.date + ' ' + t.time + '</td><td>' + escapeHtml(t.username) + '</td><td class="right num">' + formatMoney(t.amount) + '</td><td>' + statusBadge(t.status) + '</td></tr>').join('')
    : '<tr><td colspan="4" class="empty">No transactions yet.</td></tr>';
}

/* ================= Form handlers ================= */
function setupForms() {
  /* login / register tabs */
  function showTab(login) {
    $('loginForm').hidden = !login; $('registerForm').hidden = login;
    $('tabLogin').classList.toggle('active', login); $('tabRegister').classList.toggle('active', !login);
    $('tabLogin').setAttribute('aria-selected', login); $('tabRegister').setAttribute('aria-selected', !login);
  }
  $('tabLogin').onclick = () => showTab(true);
  $('tabRegister').onclick = () => showTab(false);

  $('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!loginUser($('lUser').value, $('lPass').value)) return showMessage($('loginMsg'), 'Username or password is incorrect.');
    go('dashboard');
  });
  $('registerForm').addEventListener('submit', e => {
    e.preventDefault();
    const r = registerUser({ holder: $('rHolder').value, username: $('rUser').value.trim(), password: $('rPass').value,
      payPassword: $('rPay').value, limit: $('rLimit').value });
    if (r.error) return showMessage($('regMsg'), r.error);
    loginUser(r.user.username, $('rPass').value);
    go('dashboard');
  });

  /* admin login */
  $('adminForm').addEventListener('submit', e => {
    e.preventDefault();
    if ($('aUser').value.trim().toLowerCase() === ADMIN_USERNAME && hashText($('aPass').value) === ADMIN_PASSWORD_HASH) {
      sset(KEYS.admin, true); go('admin');
    } else showMessage($('adminMsg'), 'Administrator username or password is incorrect.');
  });

  /* process payment */
  $('payForm').addEventListener('submit', e => {
    e.preventDefault();
    const user = currentUser(), msg = $('payMsg'), s = getSummary(user);
    const amt = Math.round(parseFloat($('pAmount').value) * 100) / 100;
    if (!$('pDesc').value.trim()) return showMessage(msg, 'Enter who you are paying.');
    if (!(amt > 0)) return showMessage(msg, 'Enter an amount greater than zero.');
    if (amt > s.available) return showMessage(msg, 'This amount is more than your available credit of ' + formatMoney(s.available) + '.');
    if (hashText($('pPass').value) !== user.payHash) return showMessage(msg, 'Payment password is incorrect.');
    sset(KEYS.pending, { username: user.username, amount: amt, description: $('pDesc').value.trim(),
      otp: newOtp(), expires: Date.now() + OTP_SECONDS * 1000, tries: 0 });
    go('otp');
  });

  /* payment OTP */
  $('otpForm').addEventListener('submit', e => {
    e.preventDefault();
    const user = currentUser(), p = sget(KEYS.pending);
    if (!p) return go('payment');
    if ($('oCode').value.trim() === p.otp) {
      return finishPayment(getSummary(user).available < p.amount ? 'Failed' : 'Success');
    }
    p.tries++; sset(KEYS.pending, p);
    const left = MAX_OTP_TRIES - p.tries;
    if (left <= 0) return finishPayment('Failed');
    showMessage($('otpMsg'), 'That code is not correct. ' + left + (left === 1 ? ' attempt' : ' attempts') + ' left.');
    $('oCode').value = ''; $('oCode').focus();
  });
  $('oResend').addEventListener('click', () => {
    const p = sget(KEYS.pending); if (!p) return go('payment');
    p.otp = newOtp(); p.expires = Date.now() + OTP_SECONDS * 1000; sset(KEYS.pending, p);
    $('oDemo').textContent = p.otp; $('oCode').value = '';
    showMessage($('otpMsg'), 'A new code has been sent.', 'info');
    updateOtpTimer();
  });
  $('oCancel').addEventListener('click', () => finishPayment('Cancelled'));

  /* history filters */
  $('hSearch').addEventListener('input', drawHistory);
  $('hFilter').addEventListener('change', drawHistory);

  /* security center */
  $('spForm').addEventListener('submit', e => {
    e.preventDefault();
    const user = currentUser(), msg = $('spMsg');
    if (hashText($('curPay').value) !== user.payHash) return showMessage(msg, 'Current payment password is incorrect.');
    if ($('newPay').value.length < 6) return showMessage(msg, 'New payment password must be at least 6 characters.');
    if (hashText($('newPay').value) === user.passwordHash) return showMessage(msg, 'Payment password must differ from your login password.');
    user.payHash = hashText($('newPay').value); saveUser(user);
    $('spForm').reset(); showMessage(msg, 'Payment password updated.', 'ok');
  });
  $('slForm').addEventListener('submit', e => {
    e.preventDefault();
    const user = currentUser(), msg = $('slMsg');
    if (hashText($('curPass').value) !== user.passwordHash) return showMessage(msg, 'Current login password is incorrect.');
    if ($('newPass').value.length < 8) return showMessage(msg, 'New login password must be at least 8 characters.');
    if (hashText($('newPass').value) === user.payHash) return showMessage(msg, 'Login password must differ from your payment password.');
    user.passwordHash = hashText($('newPass').value); saveUser(user);
    $('slForm').reset(); showMessage(msg, 'Login password updated.', 'ok');
  });
}

/* ================= Start ================= */
seedDemoData();
setupForms();
window.addEventListener('hashchange', route);
route();

/* Keep "logged in" status fresh and auto-refresh the admin page */
setInterval(() => { const u = sget(KEYS.session); if (u) touchActive(u); }, 30000);
setInterval(() => { if (currentView === 'admin' && sget(KEYS.admin)) showAdmin(); }, 5000);
