/* NetLoom для Android — фоновая логика: блокировка рекламы, защита от опасных сайтов, VPN.
 * Библиотеки lib/filters.js и lib/links.js — те же, что в версии для компьютера.
 * Ядра VPN (Xray, sing-box) запускает само приложение: связь через runtime.connectNative("netloom"). */
'use strict';

const NATIVE_APP = 'netloom';
const OWN_ORIGIN = browser.runtime.getURL('');
const BLOCKED_PAGE = browser.runtime.getURL('pages/blocked.html');
const DAY = 24 * 3600 * 1000;

// Базы фильтров: Adblock (EasyList) и AdGuard вместе. Первая копия — внутри приложения.
const LISTS = [
  { id: 'easylist', urls: ['https://easylist.to/easylist/easylist.txt', 'https://easylist-downloads.adblockplus.org/easylist.txt'] },
  { id: 'easyprivacy', urls: ['https://easylist.to/easylist/easyprivacy.txt', 'https://easylist-downloads.adblockplus.org/easyprivacy.txt'] },
  { id: 'ruadlist', urls: ['https://easylist-downloads.adblockplus.org/advblock.txt'] },
  { id: 'rucounters', urls: ['https://easylist-downloads.adblockplus.org/cntblock.txt'] },
  { id: 'adguard-base', urls: ['https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt'] },
  { id: 'adguard-russian', urls: ['https://filters.adtidy.org/extension/ublock/filters/1.txt'] },
  { id: 'netloom-rules', urls: null }
];
// Опасные сайты: проверка идёт на телефоне, адреса никуда не отправляются
const SECURITY_LISTS = [
  { id: 'urlhaus', kind: 'malware', urls: ['https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt', 'https://curbengh.github.io/malware-filter/urlhaus-filter-online.txt'] },
  { id: 'phishing', kind: 'phishing', urls: ['https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt', 'https://curbengh.github.io/malware-filter/phishing-filter.txt'] }
];

const DEFAULTS = {
  adblock: true,
  security: true,
  vpn: false,
  ruDirect: true,
  rules: [],          // [{host, mode: 'vpn' | 'direct'}]
  allowlist: [],      // сайты без блокировки рекламы
  servers: [],        // [{id, name, link, proto, address, port, sub}]
  subs: [],           // [{id, url, name, info, updated, error}]
  activeServerId: null
};

const RU_SET = new Set(['ru', 'su', 'xn--p1ai', 'xn--p1acf', 'xn--80adxhks', 'xn--d1acj3b', 'xn--80asehdb',
  'xn--c1avg', 'xn--80aswg', 'moscow', 'tatar', 'vk.com', 'vk.me', 'vkuser.net', 'userapi.com',
  'yandex.net', 'yastatic.net', 'yandex.com', 'mycdn.me', 'vkvideo.ru']);

let settings = null;
const state = {
  engine: null,
  engineStats: null,
  security: [],               // [{kind, list}]
  securityBypass: new Set(),  // сайты, открытые «всё равно» (до перезапуска)
  genericReg: null,
  tabTop: new Map(),
  blocked: new Map(),
  blockedTotal: 0,
  cosmeticCache: new Map(),
  vpn: { status: 'off', error: '', port: 0, user: '', pass: '', serverId: null, gen: 0 },
  pings: {},
  listsUpdating: false
};

// ───────────────────────── утилиты ─────────────────────────
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (e) { return ''; }
}
function suffixHit(host, set) {
  let h = host;
  while (h) {
    if (set.has(h)) return h;
    const i = h.indexOf('.');
    if (i < 0) return null;
    h = h.slice(i + 1);
  }
  return null;
}
function randomToken(len) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}
function hashId(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return 's' + h1.toString(36) + h2.toString(36);
}
async function saveSettings() {
  await browser.storage.local.set({ settings: settings });
}
function normalizeDomain(s) {
  s = String(s || '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[\/:?#].*$/, '').replace(/^\*?\./, '').replace(/^www\./, '');
  return /^[a-z0-9.\-]+$/.test(s) && s.indexOf('.') > 0 ? s : '';
}

// ───────────────────────── блокировка рекламы ─────────────────────────
const probeEl = document.createElement('div');
const selectorCache = new Map();
function validateSelector(sel) {
  let ok = selectorCache.get(sel);
  if (ok === undefined) {
    try { probeEl.querySelector(sel); ok = true; } catch (e) { ok = false; }
    selectorCache.set(sel, ok);
  }
  return ok;
}

async function readList(id) {
  const key = 'list:' + id;
  const stored = (await browser.storage.local.get(key))[key];
  if (stored && stored.text) return stored.text;
  try {
    const r = await fetch(browser.runtime.getURL('filters/' + id + '.txt'));
    if (r.ok) return await r.text();
  } catch (e) { /* файла нет в сборке */ }
  return '';
}

async function loadEngine() {
  const engine = new NCFilters.Engine({ validateSelector: validateSelector });
  const texts = [];
  for (const L of LISTS) {
    const text = await readList(L.id);
    if (text) texts.push(text);
  }
  engine.addLists(texts);
  state.engine = engine;
  state.engineStats = engine.stats();
  state.cosmeticCache.clear();
  await registerGenericCSS();
}

// списки опасных сайтов — просто адреса: храним множеством строк, это в разы легче правил
async function loadSecurity() {
  const lists = [];
  for (const L of SECURITY_LISTS) {
    const text = await readList(L.id);
    if (!text) continue;
    const list = new NCFilters.HostList();
    list.add(text);
    lists.push({ kind: L.kind, list: list });
  }
  state.security = lists;
}

function dangerOf(url, host) {
  if (!settings.security || !state.security.length || state.securityBypass.has(host)) return null;
  for (const s of state.security) if (s.list.match(url, host)) return s.kind;
  return null;
}

async function registerGenericCSS() {
  if (state.genericReg) {
    try { await state.genericReg.unregister(); } catch (e) { /* уже снят */ }
    state.genericReg = null;
  }
  if (!settings.adblock || !state.engine) return;
  // общие правила — только «дешёвые» селекторы (#id, .class), одной таблицей на все сайты
  const sels = state.engine.genericSelectors();
  if (!sels.length) return;
  const css = sels.map(function (s) { return s + '{display:none!important}'; }).join('\n');
  const exclude = state.engine.genericExcludedDomains().concat(settings.allowlist)
    .filter(function (d) { return /^[a-z0-9.\-]+$/.test(d) && d.indexOf('.') > 0; })
    .map(function (d) { return '*://*.' + d + '/*'; });
  try {
    state.genericReg = await browser.contentScripts.register({
      matches: ['http://*/*', 'https://*/*'],
      excludeMatches: exclude,
      css: [{ code: css }],
      runAt: 'document_start',
      allFrames: true
    });
  } catch (e) {
    console.error('NetLoom: косметические фильтры', e);
  }
}

async function updateLists(force) {
  if (state.listsUpdating) return false;
  state.listsUpdating = true;
  let changed = false, securityChanged = false;
  try {
    for (const L of LISTS.concat(SECURITY_LISTS)) {
      if (!L.urls) continue;
      const isSecurity = SECURITY_LISTS.indexOf(L) >= 0;
      const key = 'list:' + L.id;
      const meta = (await browser.storage.local.get(key))[key];
      const maxAge = isSecurity ? DAY : 4 * DAY;
      if (!force && meta && Date.now() - meta.fetched < maxAge) continue;
      for (const url of L.urls) {
        try {
          const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
          if (!r.ok) continue;
          const text = await r.text();
          if (text.length < 1000 || !/^\s*[\[!]/.test(text)) continue;
          await browser.storage.local.set({ [key]: { text: text, fetched: Date.now(), url: url } });
          if (isSecurity) securityChanged = true; else changed = true;
          break;
        } catch (e) { /* пробуем следующее зеркало */ }
      }
    }
    if (changed) await loadEngine();
    if (securityChanged) await loadSecurity();
  } finally {
    state.listsUpdating = false;
  }
  return changed || securityChanged;
}

function isAllowlisted(host) {
  return !!host && !!suffixHit(host, new Set(settings.allowlist));
}

function topHostOf(d) {
  const t = state.tabTop.get(d.tabId);
  if (t) return t;
  if (d.frameAncestors && d.frameAncestors.length) return hostOf(d.frameAncestors[d.frameAncestors.length - 1].url);
  return hostOf(d.documentUrl || d.originUrl || '');
}

function onBeforeRequest(d) {
  if ((d.originUrl || '').startsWith(OWN_ORIGIN) && d.type !== 'main_frame') return;
  if (!/^(https?|wss?):/.test(d.url)) return;
  const host = hostOf(d.url);

  // защита от опасных сайтов: страницы, рамки и загрузки
  if (settings.security && state.security.length) {
    const kind = dangerOf(d.url, host);
    if (kind) {
      if (d.type === 'main_frame') {
        return { redirectUrl: BLOCKED_PAGE + '?kind=' + kind + '&url=' + encodeURIComponent(d.url) };
      }
      return { cancel: true };
    }
  }

  if (d.type === 'main_frame') {
    state.tabTop.set(d.tabId, host);
    state.blocked.set(d.tabId, 0);
    return;
  }
  if (!settings.adblock || !state.engine) return;
  const top = topHostOf(d);
  if (top && isAllowlisted(top)) return;
  const docHost = hostOf(d.documentUrl || '') || top;
  if (state.engine.match({ url: d.url, host: host, type: d.type, docHost: docHost })) {
    if (d.tabId >= 0) state.blocked.set(d.tabId, (state.blocked.get(d.tabId) || 0) + 1);
    state.blockedTotal++;
    return { cancel: true };
  }
}

function onCommitted(d) {
  if (!/^https?:/.test(d.url)) return;
  const host = hostOf(d.url);
  if (d.frameId === 0) state.tabTop.set(d.tabId, host);
  if (!settings.adblock || !state.engine) return;
  const top = state.tabTop.get(d.tabId) || host;
  if (isAllowlisted(top) || isAllowlisted(host)) return;
  let css = state.cosmeticCache.get(host);
  if (css === undefined) {
    css = state.engine.cosmeticFor(host);
    if (state.cosmeticCache.size > 300) state.cosmeticCache.clear();
    state.cosmeticCache.set(host, css);
  }
  if (css) {
    browser.tabs.insertCSS(d.tabId, { code: css, frameId: d.frameId, runAt: 'document_start', cssOrigin: 'user' })
      .catch(function () { /* вкладка уже закрыта */ });
  }
}

// ───────────────────────── связь с приложением ─────────────────────────
let nativePort = null;
let msgSeq = 0;
const pending = new Map();

function nativeConnect() {
  if (nativePort) return nativePort;
  nativePort = browser.runtime.connectNative(NATIVE_APP);
  nativePort.onMessage.addListener(onNativeMessage);
  nativePort.onDisconnect.addListener(function () {
    nativePort = null;
    pending.forEach(function (w) { clearTimeout(w.timer); w.reject(new Error('Приложение не отвечает')); });
    pending.clear();
  });
  return nativePort;
}

function nativeCall(cmd, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let port;
    try { port = nativeConnect(); } catch (e) { reject(new Error('Нет связи с приложением')); return; }
    const id = ++msgSeq;
    const timer = setTimeout(function () {
      pending.delete(id);
      reject(new Error('Приложение не ответило вовремя'));
    }, timeoutMs || 15000);
    pending.set(id, { resolve: resolve, reject: reject, timer: timer });
    try {
      port.postMessage(Object.assign({ id: id, cmd: cmd }, args || {}));
    } catch (e) {
      clearTimeout(timer); pending.delete(id);
      reject(new Error('Нет связи с приложением'));
    }
  });
}

function notifyApp(event, data) {
  try { nativeConnect().postMessage(Object.assign({ event: event }, data || {})); } catch (e) { /* приложение ещё не готово */ }
}

/** Сообщения от приложения: ответы на запросы и команды (кнопка VPN и т.п.) */
function onNativeMessage(m) {
  if (!m) return;
  if (m.event) {
    if (m.event === 'core-exit' && (state.vpn.status === 'connected' || state.vpn.status === 'connecting')) {
      state.vpn.port = 0;
      setVpnStatus('error', 'Ядро VPN остановилось' + (m.log ? ': ' + lastLine(m.log) : ''));
    } else if (m.event === 'toggle-vpn') {
      handlers.setVpn({ on: !settings.vpn });
    } else if (m.event === 'hello') {
      pushState();
    }
    return;
  }
  const w = pending.get(m.id);
  if (!w) return;
  pending.delete(m.id);
  clearTimeout(w.timer);
  if (m.ok) w.resolve(m); else w.reject(new Error(m.error || 'Ошибка приложения'));
}

function lastLine(s) {
  const lines = String(s).trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

// ───────────────────────── VPN ─────────────────────────
function activeServer() {
  return settings.servers.find(function (s) { return s.id === settings.activeServerId; }) || null;
}

function pushState() {
  const srv = activeServer();
  notifyApp('state', { vpn: settings.vpn, status: state.vpn.status, error: state.vpn.error, server: srv ? srv.name : '' });
}

function setVpnStatus(status, error) {
  state.vpn.status = status;
  state.vpn.error = error || '';
  pushState();
  browser.runtime.sendMessage({ type: 'stateChanged' }).catch(function () {});
  // WebRTC не должен раскрывать настоящий адрес в обход VPN
  try {
    browser.privacy.network.webRTCIPHandlingPolicy.set({ value: settings.vpn ? 'disable_non_proxied_udp' : 'default' })
      .catch(function () { /* нет на этой версии */ });
  } catch (e) { /* нет на этой версии */ }
}

async function vpnConnect() {
  const gen = ++state.vpn.gen;
  const srv = activeServer();
  if (!srv) { setVpnStatus('error', 'Добавьте сервер: ссылку vless://… или подписку'); return; }
  let built;
  const creds = { user: randomToken(8), pass: randomToken(16) };
  try { built = NCLinks.buildConfig(NCLinks.parseLink(srv.link), creds); } catch (e) { setVpnStatus('error', e.message); return; }
  setVpnStatus('connecting');
  try {
    const r = await nativeCall('start', { core: built.core, config: built.config }, 25000);
    if (gen !== state.vpn.gen) return;
    state.vpn.port = r.port;
    state.vpn.user = creds.user;
    state.vpn.pass = creds.pass;
    state.vpn.serverId = srv.id;
    setVpnStatus('connected');
  } catch (e) {
    if (gen !== state.vpn.gen) return;
    state.vpn.port = 0;
    setVpnStatus('error', e.message);
  }
}

async function vpnDisconnect() {
  state.vpn.gen++;
  state.vpn.port = 0;
  try { await nativeCall('stop', {}, 5000); } catch (e) { /* уже остановлено */ }
  setVpnStatus('off');
}

// ───────────────────────── маршрутизация ─────────────────────────
function isPrivateHost(h) {
  if (!h) return true;
  if (h === 'localhost' || /\.(localhost|local|lan|home\.arpa|internal|intranet|corp)$/.test(h)) return true;
  if (h.indexOf(':') >= 0) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  if (h.indexOf('.') < 0) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}

function routeFor(host) {
  const rules = new Map(settings.rules.map(function (r) { return [r.host, r.mode]; }));
  const hit = suffixHit(host, new Set(rules.keys()));
  if (hit) return rules.get(hit);
  if (isPrivateHost(host)) return 'direct';
  if (settings.ruDirect && suffixHit(host, RU_SET)) return 'direct';
  return 'vpn';
}

const DIRECT = { type: 'direct' };
const KILL_SWITCH = [{ type: 'socks', host: '127.0.0.1', port: 9, proxyDNS: true, failoverTimeout: 1 }];

function onProxyRequest(d) {
  if (!settings.vpn) return DIRECT;
  const host = hostOf(d.url);
  if (routeFor(host) === 'direct') return DIRECT;
  if (state.vpn.status === 'connected' && state.vpn.port) {
    return [{ type: 'socks', host: '127.0.0.1', port: state.vpn.port, username: state.vpn.user,
      password: state.vpn.pass, proxyDNS: true, failoverTimeout: 5 }];
  }
  // VPN включён, но не подключён: служебные запросы самого NetLoom — напрямую,
  // всё остальное блокируется, чтобы настоящий адрес не раскрылся
  if ((d.originUrl || '').startsWith(OWN_ORIGIN) || (d.documentUrl || '').startsWith(OWN_ORIGIN)) return DIRECT;
  return KILL_SWITCH;
}

// ───────────────────────── серверы и подписки ─────────────────────────
function serverFromLink(link, subId) {
  const p = NCLinks.parseLink(link);
  return { id: hashId(link), name: p.name, link: link, proto: p.title, address: p.address, port: p.port, sub: subId || null };
}

async function fetchText(url) {
  try {
    const r = await nativeCall('fetch', { url: url }, 35000);
    return { body: r.body || '', headers: r.headers || {} };
  } catch (e) {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw new Error('Сервер подписки ответил ' + r.status);
    return { body: await r.text(), headers: {
      'subscription-userinfo': r.headers.get('subscription-userinfo') || '',
      'profile-title': r.headers.get('profile-title') || ''
    } };
  }
}

function decodeTitle(t) {
  if (!t) return '';
  if (t.startsWith('base64:')) { try { return NCLinks.b64decode(t.slice(7)); } catch (e) { return ''; } }
  return t;
}

async function refreshSub(sub) {
  try {
    const res = await fetchText(sub.url);
    const links = NCLinks.parseSubscription(res.body);
    const fresh = [];
    const seen = new Set();
    for (const link of links) {
      try {
        const s = serverFromLink(link, sub.id);
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        fresh.push(s);
      } catch (e) { /* неподдерживаемая ссылка — пропускаем */ }
    }
    if (!fresh.length) throw new Error('В подписке нет поддерживаемых серверов');
    settings.servers = settings.servers.filter(function (s) { return s.sub !== sub.id; }).concat(fresh);
    sub.info = NCLinks.parseUserInfo(res.headers['subscription-userinfo']);
    sub.name = decodeTitle(res.headers['profile-title']) || sub.name;
    sub.updated = Date.now();
    sub.error = null;
  } catch (e) {
    sub.error = e.message;
  }
  if (!activeServer() && settings.servers.length) settings.activeServerId = settings.servers[0].id;
  await saveSettings();
  return sub.error;
}

async function addInput(text) {
  const items = String(text || '').split(/[\r\n\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  let added = 0;
  const errors = [];
  for (const item of items) {
    try {
      if (NCLinks.isSubscriptionURL(item)) {
        if (settings.subs.some(function (s) { return s.url === item; })) { errors.push('Подписка уже добавлена'); continue; }
        const sub = { id: hashId('sub:' + item), url: item, name: hostOf(item), info: null, updated: 0, error: null };
        settings.subs.push(sub);
        const err = await refreshSub(sub);
        if (err) errors.push('Подписка: ' + err); else added++;
      } else {
        const s = serverFromLink(item, null);
        if (settings.servers.some(function (x) { return x.id === s.id; })) { errors.push('«' + s.name + '» уже есть'); continue; }
        settings.servers.push(s);
        added++;
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!activeServer() && settings.servers.length) settings.activeServerId = settings.servers[0].id;
  await saveSettings();
  pushState();
  return { added: added, errors: errors };
}

async function pingAll() {
  const list = settings.servers.slice();
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const s = list[i++];
      try {
        const r = await nativeCall('tcpping', { host: s.address, port: s.port }, 8000);
        state.pings[s.id] = r.ms;
      } catch (e) {
        state.pings[s.id] = -1;
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  return state.pings;
}

// ───────────────────────── сообщения от страниц NetLoom ─────────────────────────
async function getState() {
  const srv = activeServer();
  let app = {};
  try { app = (await nativeCall('appget', {}, 3000)).settings || {}; } catch (e) { /* без настроек приложения */ }
  return {
    adblock: settings.adblock,
    security: settings.security,
    vpn: settings.vpn,
    vpnStatus: state.vpn.status,
    vpnError: state.vpn.error,
    ruDirect: settings.ruDirect,
    rules: settings.rules,
    allowlist: settings.allowlist,
    servers: settings.servers,
    subs: settings.subs,
    activeServerId: settings.activeServerId,
    activeServerName: srv ? srv.name : '',
    pings: state.pings,
    filters: state.engineStats,
    securityRules: state.security.reduce(function (n, x) { return n + x.list.count; }, 0),
    blockedTotal: state.blockedTotal,
    app: app
  };
}

const handlers = {
  getState: getState,
  async setAdblock(m) {
    settings.adblock = !!m.on;
    await saveSettings();
    await registerGenericCSS();
    return true;
  },
  async setSecurity(m) { settings.security = !!m.on; await saveSettings(); return true; },
  async bypassDanger(m) { const h = hostOf(m.url); if (h) state.securityBypass.add(h); return true; },
  async setAllowlist(m) {
    settings.allowlist = Array.from(new Set(String(m.text || '').split(/[\s,;]+/).map(normalizeDomain).filter(Boolean))).sort();
    await saveSettings();
    await registerGenericCSS();
    return settings.allowlist;
  },
  async setVpn(m) {
    settings.vpn = !!m.on;
    await saveSettings();
    if (settings.vpn) await vpnConnect(); else await vpnDisconnect();
    return true;
  },
  async selectServer(m) {
    settings.activeServerId = m.id;
    await saveSettings();
    if (settings.vpn) await vpnConnect(); else pushState();
    return true;
  },
  addInput(m) { return addInput(m.text); },
  async removeServer(m) {
    settings.servers = settings.servers.filter(function (s) { return s.id !== m.id; });
    if (settings.activeServerId === m.id) settings.activeServerId = settings.servers.length ? settings.servers[0].id : null;
    await saveSettings();
    pushState();
    return true;
  },
  async removeSub(m) {
    settings.subs = settings.subs.filter(function (s) { return s.id !== m.id; });
    settings.servers = settings.servers.filter(function (s) { return s.sub !== m.id; });
    if (!activeServer()) settings.activeServerId = settings.servers.length ? settings.servers[0].id : null;
    await saveSettings();
    pushState();
    return true;
  },
  async updateSub(m) {
    const sub = settings.subs.find(function (s) { return s.id === m.id; });
    return sub ? refreshSub(sub) : 'Подписка не найдена';
  },
  pingAll: pingAll,
  async setRuDirect(m) { settings.ruDirect = !!m.on; await saveSettings(); return true; },
  async setRule(m) {
    const host = normalizeDomain(m.host);
    if (!host) throw new Error('Введите адрес сайта, например example.com');
    settings.rules = settings.rules.filter(function (r) { return r.host !== host; });
    if (m.mode === 'vpn' || m.mode === 'direct') settings.rules.push({ host: host, mode: m.mode });
    settings.rules.sort(function (a, b) { return a.host.localeCompare(b.host); });
    await saveSettings();
    return settings.rules;
  },
  updateLists() { return updateLists(true); },
  async appSet(m) { await nativeCall('appset', { key: m.key, value: m.value }, 5000); return true; },
  async appAction(m) { await nativeCall('action', { name: m.name }, 10000); return true; }
};

browser.runtime.onMessage.addListener(function (msg, sender) {
  if (sender.id !== browser.runtime.id || !msg || !handlers[msg.type]) return;
  return Promise.resolve(handlers[msg.type](msg)).catch(function (e) { return { error: e.message }; });
});

// ───────────────────────── запуск ─────────────────────────
async function init() {
  const stored = (await browser.storage.local.get('settings')).settings || {};
  settings = Object.assign({}, DEFAULTS, stored);

  browser.proxy.onRequest.addListener(onProxyRequest, { urls: ['<all_urls>'] });
  browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ['<all_urls>'] }, ['blocking']);
  browser.webNavigation.onCommitted.addListener(onCommitted);
  browser.tabs.onRemoved.addListener(function (id) { state.tabTop.delete(id); state.blocked.delete(id); });

  nativeConnect();
  setVpnStatus('off');
  await Promise.all([loadEngine(), loadSecurity()]);
  if (settings.vpn) vpnConnect();

  browser.alarms.create('lists', { delayInMinutes: 3, periodInMinutes: 360 });
  browser.alarms.create('subs', { delayInMinutes: 5, periodInMinutes: 720 });
  browser.alarms.onAlarm.addListener(async function (a) {
    if (a.name === 'lists') updateLists(false);
    if (a.name === 'subs') {
      for (const sub of settings.subs) await refreshSub(sub);
    }
  });
}

init().catch(function (e) { console.error('NetLoom: ошибка запуска', e); });
