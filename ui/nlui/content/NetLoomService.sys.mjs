/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * NetLoom — служба браузера: блокировка рекламы, VPN/прокси, настройки.
 * Работает в главном процессе с полными правами. Интерфейс (панели, настройки)
 * обращается к ней напрямую и подписывается на уведомление "netloom-state".
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const DAY = 24 * 3600 * 1000;
const STATE_TOPIC = "netloom-state";
const COUNT_TOPIC = "netloom-blocked";

const LISTS = [
  { id: "easylist", urls: ["https://easylist.to/easylist/easylist.txt", "https://easylist-downloads.adblockplus.org/easylist.txt"] },
  { id: "easyprivacy", urls: ["https://easylist.to/easylist/easyprivacy.txt", "https://easylist-downloads.adblockplus.org/easyprivacy.txt"] },
  { id: "ruadlist", urls: ["https://easylist-downloads.adblockplus.org/advblock.txt"] },
  { id: "rucounters", urls: ["https://easylist-downloads.adblockplus.org/cntblock.txt"] },
  { id: "netloom-rules", urls: null },
];

const DEFAULTS = {
  adblock: true,
  vpn: false,
  ruDirect: true,
  rules: [], // [{host, mode: "vpn" | "direct"}]
  allowlist: [], // сайты без блокировки рекламы
  servers: [], // [{id, name, link, proto, address, port, sub}]
  subs: [], // [{id, url, name, info, updated, error}]
  activeServerId: null,
};

const RU_SUFFIXES = new Set([
  "ru", "su", "xn--p1ai", "xn--p1acf", "xn--80adxhks", "xn--d1acj3b", "xn--80asehdb", "xn--c1avg",
  "xn--80aswg", "moscow", "tatar", "vk.com", "vk.me", "vkuser.net", "userapi.com", "yandex.net",
  "yastatic.net", "yandex.com", "mycdn.me", "vkvideo.ru",
]);

// ───────── вспомогательное ─────────
function suffixMatch(host, set) {
  let h = host;
  while (h) {
    if (set.has(h)) return h;
    const i = h.indexOf(".");
    if (i < 0) return null;
    h = h.slice(i + 1);
  }
  return null;
}

function isPrivateHost(h) {
  if (!h) return true;
  if (h === "localhost" || /\.(localhost|local|lan|home\.arpa|internal|intranet|corp)$/.test(h)) return true;
  if (h.includes(":")) return h === "::1" || /^f[cd]/i.test(h) || /^fe[89ab]/i.test(h);
  if (!h.includes(".")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normalizeDomain(s) {
  s = String(s || "").trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/:?#].*$/, "").replace(/^\*?\./, "");
  return /^[a-z0-9.-]+$/.test(s) && s.includes(".") || /^[a-z0-9-]+$/.test(s) ? s : "";
}

function randomHex(bytes) {
  const rng = Cc["@mozilla.org/security/random-generator;1"].getService(Ci.nsIRandomGenerator);
  return rng.generateRandomBytes(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hashId(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return "s" + h1.toString(36) + h2.toString(36);
}

function sleep(ms) {
  return new Promise(r => lazy.setTimeout(r, ms));
}

async function httpGet(url, { userAgent } = {}) {
  const doFetch = globalThis.fetch || Services.appShell.hiddenDOMWindow.fetch.bind(Services.appShell.hiddenDOMWindow);
  const headers = {};
  if (userAgent) headers["User-Agent"] = userAgent;
  const r = await doFetch(url, { cache: "no-store", credentials: "omit", headers });
  if (!r.ok) throw new Error("Сервер ответил " + r.status);
  return { text: await r.text(), headers: r.headers };
}

/** Время TCP-соединения в мс или -1 */
function tcpPing(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    let done = false, transport = null, timer = null;
    const start = Cu.now();
    const finish = ms => {
      if (done) return;
      done = true;
      if (timer) lazy.clearTimeout(timer);
      try { transport?.close(Cr.NS_OK); } catch (e) {}
      resolve(ms);
    };
    try {
      const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
      transport = sts.createTransport([], host, port, null, null);
      transport.setEventSink({
        onTransportStatus(t, status) {
          if (status === Ci.nsISocketTransport.STATUS_CONNECTED_TO) finish(Math.round(Cu.now() - start));
        },
        QueryInterface: ChromeUtils.generateQI(["nsITransportEventSink"]),
      }, Services.tm.mainThread);
      const input = transport.openInputStream(0, 0, 0);
      input.QueryInterface(Ci.nsIAsyncInputStream).asyncWait({
        onInputStreamReady(s) {
          try { s.available(); } catch (e) { finish(-1); }
        },
        QueryInterface: ChromeUtils.generateQI(["nsIInputStreamCallback"]),
      }, 0, 0, Services.tm.mainThread);
    } catch (e) {
      finish(-1);
      return;
    }
    timer = lazy.setTimeout(() => finish(-1), timeoutMs);
  });
}

function freePort() {
  const ss = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
  ss.init(-1, true, -1);
  const port = ss.port;
  ss.close();
  return port;
}

// ───────── библиотеки (общие с тестами) ─────────
const lib = {};
Services.scriptloader.loadSubScript("chrome://netloom/content/lib/filters.js", lib);
Services.scriptloader.loadSubScript("chrome://netloom/content/lib/links.js", lib);
const NCFilters = lib.NCFilters || globalThis.NCFilters;
const NCLinks = lib.NCLinks || globalThis.NCLinks;

const CP = Ci.nsIContentPolicy;
const TYPE_NAMES = new Map();
for (const [k, v] of Object.entries({
  TYPE_SCRIPT: "script", TYPE_IMAGE: "image", TYPE_IMAGESET: "image", TYPE_STYLESHEET: "stylesheet",
  TYPE_OBJECT: "object", TYPE_OBJECT_SUBREQUEST: "object", TYPE_SUBDOCUMENT: "sub_frame",
  TYPE_DOCUMENT: "main_frame", TYPE_PING: "ping", TYPE_BEACON: "beacon",
  TYPE_XMLHTTPREQUEST: "xmlhttprequest", TYPE_FETCH: "xmlhttprequest", TYPE_FONT: "font",
  TYPE_MEDIA: "media", TYPE_WEBSOCKET: "websocket", TYPE_CSP_REPORT: "csp_report",
  TYPE_WEB_MANIFEST: "web_manifest", TYPE_SPECULATIVE: "speculative",
})) {
  if (typeof CP[k] === "number") TYPE_NAMES.set(CP[k], v);
}

// ───────── служба ─────────
export const NetLoom = {
  settings: null,
  engine: null,
  engineStats: null,
  sheetURI: null,
  vpn: { status: "off", error: "", port: 0, user: "", pass: "", gen: 0 },
  pings: {},
  core: null,
  coreLog: [],
  blocked: new WeakMap(),
  _initPromise: null,
  _saveTimer: null,
  _countTimer: null,
  _countDirty: new Set(),

  get dataDir() {
    return PathUtils.join(PathUtils.profileDir, "netloom");
  },
  get installDir() {
    return Services.dirsvc.get("GreD", Ci.nsIFile).path;
  },
  corePath(core) {
    const exe = core + (lazy.AppConstants.platform === "win" ? ".exe" : "");
    return PathUtils.join(this.installDir, "cores", core, exe);
  },

  init() {
    if (!this._initPromise) this._initPromise = this._init().catch(e => this.log("Ошибка запуска: " + e));
    return this._initPromise;
  },

  async _init() {
    await IOUtils.makeDirectory(this.dataDir, { ignoreExisting: true });
    let stored = {};
    try { stored = await IOUtils.readJSON(PathUtils.join(this.dataDir, "settings.json")); } catch (e) {}
    this.settings = Object.assign({}, DEFAULTS, stored);

    // сеть: маршрутизация через VPN и блокировка запросов
    const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(Ci.nsIProtocolProxyService);
    pps.registerChannelFilter(this, 0);
    Services.obs.addObserver(this, "http-on-opening-request");
    Services.obs.addObserver(this, "quit-application");

    await this.loadFilters();
    if (this.settings.vpn) this.vpnConnect();

    lazy.setTimeout(() => this.updateLists(false), 2 * 60 * 1000);
    this._listTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._listTimer.initWithCallback(() => this.updateLists(false), 6 * 3600 * 1000, Ci.nsITimer.TYPE_REPEATING_SLACK);
    this._subTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._subTimer.initWithCallback(() => this.refreshAllSubs(), 12 * 3600 * 1000, Ci.nsITimer.TYPE_REPEATING_SLACK);
  },

  log(msg) {
    const line = new Date().toISOString() + " " + msg;
    this.coreLog.push(line);
    if (this.coreLog.length > 300) this.coreLog.shift();
    Services.console.logStringMessage("NetLoom: " + msg);
    dump("NetLoom: " + msg + "\n");
  },

  notify() {
    Services.obs.notifyObservers(null, STATE_TOPIC);
  },

  save() {
    if (this._saveTimer) lazy.clearTimeout(this._saveTimer);
    this._saveTimer = lazy.setTimeout(() => {
      IOUtils.writeJSON(PathUtils.join(this.dataDir, "settings.json"), this.settings, { tmpPath: PathUtils.join(this.dataDir, "settings.json.tmp") })
        .catch(e => this.log("Не удалось сохранить настройки: " + e));
    }, 200);
  },

  // ═════════ Блокировка рекламы ═════════
  async readList(id) {
    for (const p of [PathUtils.join(this.dataDir, "filters", id + ".txt"), PathUtils.join(this.installDir, "nlui", "filters", id + ".txt")]) {
      try { return await IOUtils.readUTF8(p); } catch (e) {}
    }
    try {
      const r = await httpGet("chrome://netloom/content/lib/" + id + ".txt");
      return r.text;
    } catch (e) {}
    return "";
  },

  async loadFilters() {
    const engine = new NCFilters.Engine({});
    for (const L of LISTS) {
      const text = await this.readList(L.id);
      if (text) engine.addList(text);
    }
    this.engine = engine;
    this.engineStats = engine.stats();
    await this.applyStylesheet();
    this.log("фильтры: " + JSON.stringify(this.engineStats));
  },

  async applyStylesheet() {
    const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
    if (this.sheetURI && sss.sheetRegistered(this.sheetURI, sss.USER_SHEET)) {
      sss.unregisterSheet(this.sheetURI, sss.USER_SHEET);
    }
    this.sheetURI = null;
    if (!this.settings.adblock || !this.engine) return;
    const css = this.engine.userStylesheet({ allowlist: this.settings.allowlist });
    const name = "cosmetic-" + Date.now() + ".css";
    const path = PathUtils.join(this.dataDir, name);
    await IOUtils.writeUTF8(path, css);
    // старые файлы больше не нужны
    try {
      for (const f of await IOUtils.getChildren(this.dataDir)) {
        if (/cosmetic-\d+\.css$/.test(f) && !f.endsWith(name)) IOUtils.remove(f).catch(() => {});
      }
    } catch (e) {}
    this.sheetURI = Services.io.newURI(PathUtils.toFileURI(path));
    sss.loadAndRegisterSheet(this.sheetURI, sss.USER_SHEET);
  },

  async updateLists(force) {
    if (this._listsUpdating) return false;
    this._listsUpdating = true;
    let changed = false;
    try {
      const dir = PathUtils.join(this.dataDir, "filters");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      for (const L of LISTS) {
        if (!L.urls) continue;
        const path = PathUtils.join(dir, L.id + ".txt");
        try {
          const st = await IOUtils.stat(path);
          if (!force && Date.now() - st.lastModified < 4 * DAY) continue;
        } catch (e) {}
        for (const url of L.urls) {
          try {
            const { text } = await httpGet(url);
            if (text.length < 1000 || !/^\s*[[!]/.test(text)) continue;
            await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp" });
            changed = true;
            break;
          } catch (e) {}
        }
      }
      if (changed) {
        await this.loadFilters();
        this.notify();
      }
    } finally {
      this._listsUpdating = false;
    }
    return changed;
  },

  isAllowlisted(host) {
    return !!host && !!suffixMatch(host, new Set(this.settings.allowlist));
  },

  observe(subject, topic) {
    if (topic === "http-on-opening-request") this.onRequest(subject);
    else if (topic === "quit-application") this.stopCore();
  },

  onRequest(subject) {
    if (!this.settings?.adblock || !this.engine) return;
    let channel;
    try { channel = subject.QueryInterface(Ci.nsIHttpChannel); } catch (e) { return; }
    const li = channel.loadInfo;
    if (!li || !li.browsingContextID) return;
    const type = TYPE_NAMES.get(li.externalContentPolicyType) || "other";
    const bc = BrowsingContext.get(li.browsingContextID);
    const top = bc?.top;
    const browser = top?.embedderElement;
    if (type === "main_frame") {
      if (browser) this.setCount(browser, 0);
      return;
    }
    const principal = li.loadingPrincipal;
    if (!principal || !principal.isContentPrincipal) return;
    let topHost = "";
    try { topHost = top?.currentURI?.host || ""; } catch (e) {}
    if (topHost && this.isAllowlisted(topHost)) return;
    const uri = channel.URI;
    if (!/^(https?|wss?)$/.test(uri.scheme)) return;
    let docHost = "";
    try { docHost = principal.host || topHost; } catch (e) { docHost = topHost; }
    const r = this.engine.match({ url: uri.spec, host: uri.host, type, docHost });
    if (r) {
      channel.cancel(Cr.NS_ERROR_ABORT);
      if (browser) this.setCount(browser, (this.blocked.get(browser) || 0) + 1);
    }
  },

  setCount(browser, n) {
    this.blocked.set(browser, n);
    this._countDirty.add(browser);
    if (this._countTimer) return;
    this._countTimer = lazy.setTimeout(() => {
      this._countTimer = null;
      for (const b of this._countDirty) Services.obs.notifyObservers(b, COUNT_TOPIC);
      this._countDirty.clear();
    }, 250);
  },

  blockedFor(browser) {
    return (browser && this.blocked.get(browser)) || 0;
  },

  async setAdblock(on) {
    this.settings.adblock = !!on;
    this.save();
    await this.applyStylesheet();
    this.notify();
  },

  async setSiteAllowed(host, allowed) {
    host = normalizeDomain(host);
    if (!host) return;
    const s = new Set(this.settings.allowlist);
    if (allowed) s.add(host); else s.delete(host);
    this.settings.allowlist = [...s];
    this.save();
    await this.applyStylesheet();
    this.notify();
  },

  // ═════════ VPN: маршрутизация ═════════
  routeFor(host) {
    const s = this.settings;
    const rules = new Map(s.rules.map(r => [r.host, r.mode]));
    const hit = suffixMatch(host, new Set(rules.keys()));
    if (hit) return rules.get(hit);
    if (isPrivateHost(host)) return "direct";
    if (s.ruDirect && suffixMatch(host, RU_SUFFIXES)) return "direct";
    return "vpn";
  },

  applyFilter(channel, defaultProxy, callback) {
    let result = defaultProxy;
    try { result = this.decideProxy(channel, defaultProxy); } catch (e) { this.log("proxy: " + e); }
    callback.onProxyFilterResult(result);
  },

  decideProxy(channel, defaultProxy) {
    if (!this.settings?.vpn) return defaultProxy;
    const uri = channel.URI;
    if (!uri || !/^(https?|wss?)$/.test(uri.scheme)) return defaultProxy;
    const host = uri.asciiHost.toLowerCase();
    if (this.routeFor(host) === "direct") return null;
    const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(Ci.nsIProtocolProxyService);
    const RESOLVE = Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST;
    if (this.vpn.status === "connected" && this.vpn.port) {
      return pps.newProxyInfoWithAuth("socks", "127.0.0.1", this.vpn.port, this.vpn.user, this.vpn.pass, "", "", RESOLVE, 5, null);
    }
    // VPN включён, но не подключён: служебные запросы браузера (загрузка подписки) — напрямую,
    // всё остальное блокируется, чтобы не раскрыть реальный IP
    const li = channel.loadInfo;
    if (li && !li.browsingContextID && li.triggeringPrincipal?.isSystemPrincipal) return null;
    return pps.newProxyInfo("socks", "127.0.0.1", 9, "", "", RESOLVE, 1, null);
  },

  QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter", "nsIObserver"]),

  // ═════════ VPN: ядро ═════════
  activeServer() {
    return this.settings.servers.find(s => s.id === this.settings.activeServerId) || null;
  },

  setVpnStatus(status, error = "") {
    this.vpn.status = status;
    this.vpn.error = error;
    if (error) this.log("VPN: " + error);
    this.notify();
  },

  async setVpn(on) {
    this.settings.vpn = !!on;
    this.save();
    if (on) await this.vpnConnect();
    else await this.vpnDisconnect();
  },

  async vpnConnect() {
    const gen = ++this.vpn.gen;
    const srv = this.activeServer();
    if (!srv) return this.setVpnStatus("error", "Добавьте сервер: ссылку vless://… или подписку");
    let parsed;
    try { parsed = NCLinks.parseLink(srv.link); } catch (e) { return this.setVpnStatus("error", e.message); }
    this.setVpnStatus("connecting");
    const creds = { user: randomHex(8), pass: randomHex(16) };
    const { core, config } = NCLinks.buildConfig(parsed, creds);
    try {
      const port = await this.startCore(core, config);
      if (gen !== this.vpn.gen) return;
      Object.assign(this.vpn, { port, user: creds.user, pass: creds.pass });
      this.setVpnStatus("connected");
    } catch (e) {
      if (gen !== this.vpn.gen) return;
      this.setVpnStatus("error", e.message);
    }
  },

  async vpnDisconnect() {
    this.vpn.gen++;
    this.vpn.port = 0;
    await this.stopCore();
    this.setVpnStatus("off");
  },

  async startCore(core, config) {
    await this.stopCore();
    const exe = this.corePath(core);
    if (!(await IOUtils.exists(exe))) throw new Error("Не найдено ядро VPN (cores\\" + core + ")");
    const port = freePort();
    if (core === "sing-box") config.inbounds[0].listen_port = port;
    else config.inbounds[0].port = port;
    const proc = await lazy.Subprocess.call({
      command: exe,
      arguments: core === "sing-box" ? ["run", "-c", "stdin"] : ["run", "-config", "stdin:"],
      workdir: PathUtils.parent(exe),
      stderr: "stdout",
    });
    this.core = proc;
    this.coreTail = [];
    // конфигурация передаётся через stdin — ключи не попадают на диск
    await proc.stdin.write(JSON.stringify(config));
    await proc.stdin.close();
    (async () => {
      let chunk, rest = "";
      while ((chunk = await proc.stdout.readString())) {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop();
        for (const l of lines) if (l.trim()) {
          this.coreTail.push(l);
          if (this.coreTail.length > 50) this.coreTail.shift();
        }
      }
    })().catch(() => {});
    proc.wait().then(({ exitCode }) => {
      if (this.core !== proc) return;
      this.core = null;
      if (this.vpn.status === "connected" || this.vpn.status === "connecting") {
        const last = (this.coreTail || []).slice(-1)[0] || "код " + exitCode;
        this.vpn.port = 0;
        this.setVpnStatus("error", "Ядро VPN остановилось: " + last);
      }
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (this.core !== proc) throw new Error("Ядро VPN не запустилось: " + ((this.coreTail || []).slice(-1)[0] || ""));
      if ((await tcpPing("127.0.0.1", port, 500)) >= 0) return port;
      await sleep(150);
    }
    throw new Error("Ядро VPN не ответило вовремя");
  },

  async stopCore() {
    const p = this.core;
    this.core = null;
    if (p) {
      try { await p.kill(2000); } catch (e) {}
    }
  },

  // ═════════ Серверы и подписки ═════════
  serverFromLink(link, subId) {
    const p = NCLinks.parseLink(link);
    return { id: hashId(link), name: p.name, link, proto: p.title, address: p.address, port: p.port, sub: subId || null };
  },

  async addInput(text) {
    const items = String(text || "").split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
    let added = 0;
    const errors = [];
    for (const item of items) {
      try {
        if (NCLinks.isSubscriptionURL(item)) {
          if (this.settings.subs.some(s => s.url === item)) { errors.push("Подписка уже добавлена"); continue; }
          const sub = { id: hashId("sub:" + item), url: item, name: new URL(item).hostname, info: null, updated: 0, error: null };
          this.settings.subs.push(sub);
          const err = await this.refreshSub(sub);
          if (err) errors.push("Подписка: " + err); else added++;
        } else {
          const s = this.serverFromLink(item, null);
          if (this.settings.servers.some(x => x.id === s.id)) { errors.push("«" + s.name + "» уже есть"); continue; }
          this.settings.servers.push(s);
          added++;
        }
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (!this.activeServer() && this.settings.servers.length) this.settings.activeServerId = this.settings.servers[0].id;
    this.save();
    this.notify();
    return { added, errors };
  },

  async refreshSub(sub) {
    try {
      const { text, headers } = await httpGet(sub.url, { userAgent: "v2rayN/7.0" });
      const links = NCLinks.parseSubscription(text);
      const fresh = [], seen = new Set();
      for (const link of links) {
        try {
          const s = this.serverFromLink(link, sub.id);
          if (!seen.has(s.id)) { seen.add(s.id); fresh.push(s); }
        } catch (e) {}
      }
      if (!fresh.length) throw new Error("В подписке нет поддерживаемых серверов");
      this.settings.servers = this.settings.servers.filter(s => s.sub !== sub.id).concat(fresh);
      sub.info = NCLinks.parseUserInfo(headers.get("subscription-userinfo") || "");
      let title = headers.get("profile-title") || "";
      if (title.startsWith("base64:")) { try { title = NCLinks.b64decode(title.slice(7)); } catch (e) { title = ""; } }
      if (title) sub.name = title;
      sub.updated = Date.now();
      sub.error = null;
    } catch (e) {
      sub.error = e.message;
    }
    if (!this.activeServer() && this.settings.servers.length) this.settings.activeServerId = this.settings.servers[0].id;
    this.save();
    this.notify();
    return sub.error;
  },

  async refreshAllSubs() {
    for (const sub of this.settings.subs) await this.refreshSub(sub);
  },

  async removeServer(id) {
    this.settings.servers = this.settings.servers.filter(s => s.id !== id);
    if (this.settings.activeServerId === id) this.settings.activeServerId = this.settings.servers[0]?.id || null;
    this.save();
    this.notify();
  },

  async removeSub(id) {
    this.settings.subs = this.settings.subs.filter(s => s.id !== id);
    this.settings.servers = this.settings.servers.filter(s => s.sub !== id);
    if (!this.activeServer()) this.settings.activeServerId = this.settings.servers[0]?.id || null;
    this.save();
    this.notify();
  },

  async selectServer(id) {
    this.settings.activeServerId = id;
    this.save();
    this.notify();
    if (this.settings.vpn) await this.vpnConnect();
  },

  async pingAll() {
    const list = this.settings.servers.slice();
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const s = list[i++];
        this.pings[s.id] = await tcpPing(s.address, s.port, 4000);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    this.notify();
    return this.pings;
  },

  // ═════════ Правила маршрутизации ═════════
  setRuDirect(on) {
    this.settings.ruDirect = !!on;
    this.save();
    this.notify();
  },

  setRule(host, mode) {
    host = normalizeDomain(host);
    if (!host) throw new Error("Неверный адрес сайта");
    this.settings.rules = this.settings.rules.filter(r => r.host !== host);
    if (mode === "vpn" || mode === "direct") this.settings.rules.push({ host, mode });
    this.settings.rules.sort((a, b) => a.host.localeCompare(b.host));
    this.save();
    this.notify();
  },

  ruleFor(host) {
    host = normalizeDomain(host);
    return this.settings.rules.find(r => r.host === host)?.mode || "auto";
  },
};
