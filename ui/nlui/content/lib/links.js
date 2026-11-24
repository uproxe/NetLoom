/*
 * NetLoom — разбор ссылок VPN/прокси и сборка конфигурации ядра.
 * Поддерживается: vless://, vmess://, trojan://, ss://, socks://, socks5://, http://, https://,
 * hysteria2:// (hy2://), tuic://, wireguard:// (wg://), anytls://, ssh://
 * и подписки (список ссылок или base64 со списком ссылок).
 */
(function (root) {
  'use strict';

  function b64decode(s) {
    s = String(s).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function fail(msg) { throw new Error(msg); }

  /** Разбор ссылки вида scheme://userinfo@host:port/path?query#name */
  function parseURL(link) {
    const m = /^([a-z0-9+.\-]+):\/\/([^#]*)(?:#(.*))?$/i.exec(link.trim());
    if (!m) fail('Не похоже на ссылку');
    const scheme = m[1].toLowerCase();
    let rest = m[2];
    const name = m[3] ? safeDecode(m[3]).trim() : '';
    let query = '';
    const qi = rest.indexOf('?');
    if (qi >= 0) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
    let path = '';
    const si = rest.indexOf('/');
    if (si >= 0) { path = rest.slice(si); rest = rest.slice(0, si); }
    let user = null;
    const at = rest.lastIndexOf('@');
    if (at >= 0) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
    let host = rest, port = '';
    if (rest.charAt(0) === '[') {
      const e = rest.indexOf(']');
      host = rest.slice(1, e);
      port = rest.slice(e + 2);
    } else {
      const c = rest.lastIndexOf(':');
      if (c >= 0) { host = rest.slice(0, c); port = rest.slice(c + 1); }
    }
    const params = {};
    query.split('&').forEach(function (kv) {
      if (!kv) return;
      const e = kv.indexOf('=');
      const k = safeDecode(e >= 0 ? kv.slice(0, e) : kv);
      const v = e >= 0 ? safeDecode(kv.slice(e + 1)) : '';
      params[k] = v;
    });
    return { scheme: scheme, user: user, host: host, port: port ? parseInt(port, 10) : 0,
      path: path, params: params, name: name };
  }

  function needHostPort(u) {
    if (!u.host) fail('В ссылке нет адреса сервера');
    if (!u.port || u.port < 1 || u.port > 65535) fail('В ссылке нет порта или он неверный');
  }

  // удалить пустые поля
  function clean(o) {
    Object.keys(o).forEach(function (k) {
      if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
    });
    return o;
  }

  function splitList(v) {
    return v ? v.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : undefined;
  }

  const NETWORKS = {
    tcp: 'tcp', raw: 'tcp', ws: 'ws', websocket: 'ws', grpc: 'grpc', gun: 'grpc',
    xhttp: 'xhttp', splithttp: 'xhttp', httpupgrade: 'httpupgrade', kcp: 'kcp', mkcp: 'kcp'
  };

  /** Транспорт и шифрование (streamSettings) по параметрам ссылки */
  function buildStream(p, defaultSecurity) {
    const rawNet = (p.type || 'tcp').toLowerCase();
    const net = NETWORKS[rawNet];
    if (!net) fail('Транспорт «' + rawNet + '» пока не поддерживается');
    const ss = { network: net };
    const security = (p.security || defaultSecurity || 'none').toLowerCase();

    if (security === 'tls') {
      ss.security = 'tls';
      ss.tlsSettings = clean({
        serverName: p.sni || p.peer || undefined,
        fingerprint: p.fp || 'chrome',
        alpn: splitList(p.alpn),
        allowInsecure: (p.allowInsecure === '1' || p.allowInsecure === 'true' || p.insecure === '1') ? true : undefined
      });
    } else if (security === 'reality') {
      if (!p.pbk) fail('Для Reality в ссылке нужен параметр pbk (публичный ключ)');
      ss.security = 'reality';
      ss.realitySettings = clean({
        serverName: p.sni || undefined,
        fingerprint: p.fp || 'chrome',
        publicKey: p.pbk,
        shortId: p.sid || '',
        spiderX: p.spx || undefined,
        mldsa65Verify: p.pqv || undefined
      });
      if (ss.realitySettings.shortId === undefined) ss.realitySettings.shortId = '';
    } else if (security !== 'none' && security !== '') {
      fail('Шифрование «' + security + '» не поддерживается');
    }

    const path = p.path || '';
    const host = p.host || '';
    if (net === 'tcp' && (p.headerType || '').toLowerCase() === 'http') {
      ss.tcpSettings = { header: { type: 'http', request: clean({
        path: [path || '/'], headers: host ? { Host: splitList(host) } : undefined }) } };
    } else if (net === 'ws') {
      ss.wsSettings = clean({ path: path || '/', host: host || undefined });
    } else if (net === 'grpc') {
      ss.grpcSettings = clean({
        serviceName: p.serviceName || path || '',
        multiMode: p.mode === 'multi' ? true : undefined,
        authority: p.authority || undefined
      });
    } else if (net === 'xhttp') {
      const x = clean({ path: path || '/', host: host || undefined, mode: p.mode || 'auto' });
      if (p.extra) { try { x.extra = JSON.parse(p.extra); } catch (e) { /* игнорируем битый extra */ } }
      ss.xhttpSettings = x;
    } else if (net === 'httpupgrade') {
      ss.httpupgradeSettings = clean({ path: path || '/', host: host || undefined });
    } else if (net === 'kcp') {
      ss.kcpSettings = clean({ header: { type: p.headerType || 'none' }, seed: p.seed || undefined });
    }
    return ss;
  }

  function parseVless(u) {
    needHostPort(u);
    const id = safeDecode(u.user || '');
    if (!/^[0-9a-f-]{8,}$/i.test(id)) fail('В ссылке VLESS нет UUID пользователя');
    const p = u.params;
    const user = clean({ id: id, encryption: p.encryption || 'none', flow: p.flow || undefined });
    return {
      protocol: 'vless',
      settings: { vnext: [{ address: u.host, port: u.port, users: [user] }] },
      streamSettings: buildStream(p, 'none')
    };
  }

  function parseTrojan(u) {
    needHostPort(u);
    const password = safeDecode(u.user || '');
    if (!password) fail('В ссылке Trojan нет пароля');
    return {
      protocol: 'trojan',
      settings: { servers: [{ address: u.host, port: u.port, password: password }] },
      streamSettings: buildStream(u.params, 'tls')
    };
  }

  function parseVmess(link) {
    const body = link.slice('vmess://'.length).split('#')[0];
    let j;
    try { j = JSON.parse(b64decode(body)); } catch (e) { j = null; }
    if (!j) {
      // редкий формат vmess://uuid@host:port?...
      const u = parseURL(link);
      needHostPort(u);
      return {
        out: {
          protocol: 'vmess',
          settings: { vnext: [{ address: u.host, port: u.port, users: [{ id: safeDecode(u.user || ''), security: u.params.encryption || 'auto' }] }] },
          streamSettings: buildStream(u.params, 'none')
        },
        name: u.name, host: u.host, port: u.port
      };
    }
    const port = parseInt(j.port, 10);
    if (!j.add || !port) fail('В ссылке VMess нет адреса или порта');
    if (!j.id) fail('В ссылке VMess нет UUID');
    const net = (j.net || 'tcp').toLowerCase();
    const p = {
      type: net, headerType: j.type, host: j.host, path: j.path,
      security: j.tls || 'none', sni: j.sni, alpn: j.alpn, fp: j.fp,
      serviceName: net === 'grpc' ? j.path : undefined,
      mode: net === 'grpc' ? (j.type === 'multi' ? 'multi' : undefined) : j.mode
    };
    if (net === 'grpc') { p.headerType = undefined; p.path = undefined; }
    return {
      out: {
        protocol: 'vmess',
        settings: { vnext: [{ address: j.add, port: port, users: [{ id: j.id, security: j.scy || 'auto' }] }] },
        streamSettings: buildStream(p, 'none')
      },
      name: j.ps || '', host: j.add, port: port
    };
  }

  function parseShadowsocks(link) {
    let rest = link.slice('ss://'.length);
    let name = '';
    const hi = rest.indexOf('#');
    if (hi >= 0) { name = safeDecode(rest.slice(hi + 1)); rest = rest.slice(0, hi); }
    let method, password, host, port, params = {};
    if (rest.indexOf('@') >= 0) {
      const u = parseURL('ss://' + rest);
      params = u.params;
      let ui = safeDecode(u.user || '');
      if (ui.indexOf(':') < 0) { try { ui = b64decode(ui); } catch (e) { fail('Не удалось разобрать логин Shadowsocks'); } }
      const c = ui.indexOf(':');
      method = ui.slice(0, c); password = ui.slice(c + 1);
      host = u.host; port = u.port;
    } else {
      // старый формат: ss://base64(method:password@host:port)
      let dec;
      const qi = rest.indexOf('?');
      try { dec = b64decode(qi >= 0 ? rest.slice(0, qi) : rest); } catch (e) { fail('Не удалось разобрать ссылку Shadowsocks'); }
      const at = dec.lastIndexOf('@');
      const cred = dec.slice(0, at), hp = dec.slice(at + 1);
      const c = cred.indexOf(':');
      method = cred.slice(0, c); password = cred.slice(c + 1);
      const pc = hp.lastIndexOf(':');
      host = hp.slice(0, pc).replace(/^\[|\]$/g, ''); port = parseInt(hp.slice(pc + 1), 10);
    }
    if (params.plugin) fail('Плагины Shadowsocks (obfs, v2ray-plugin) не поддерживаются');
    if (!method || !password) fail('В ссылке Shadowsocks нет метода или пароля');
    needHostPort({ host: host, port: port });
    return {
      out: { protocol: 'shadowsocks', settings: { servers: [{ address: host, port: port, method: method.toLowerCase(), password: password }] } },
      name: name, host: host, port: port
    };
  }

  function userPass(u) {
    if (u.user === null) return null;
    let ui = safeDecode(u.user);
    if (ui.indexOf(':') < 0) { try { const d = b64decode(ui); if (d.indexOf(':') > 0) ui = d; } catch (e) { /* не base64 */ } }
    const c = ui.indexOf(':');
    return c < 0 ? { user: ui, pass: '' } : { user: ui.slice(0, c), pass: ui.slice(c + 1) };
  }

  function parseSocks(u) {
    needHostPort(u);
    const up = userPass(u);
    return {
      protocol: 'socks',
      settings: { servers: [clean({ address: u.host, port: u.port, users: up ? [up] : undefined })] }
    };
  }

  function parseHttpProxy(u) {
    needHostPort(u);
    const up = userPass(u);
    const out = {
      protocol: 'http',
      settings: { servers: [clean({ address: u.host, port: u.port, users: up ? [up] : undefined })] }
    };
    if (u.scheme === 'https') out.streamSettings = { network: 'tcp', security: 'tls', tlsSettings: { serverName: u.host } };
    return out;
  }

  // ───────── Протоколы второго ядра (sing-box) ─────────
  function boolParam(v) { return v === '1' || v === 'true'; }

  function singTls(p, host, defaultAlpn) {
    return clean({
      enabled: true,
      server_name: p.sni || p.peer || undefined,
      insecure: boolParam(p.insecure) || boolParam(p.allowInsecure) || boolParam(p.allow_insecure) ? true : undefined,
      alpn: splitList(p.alpn) || defaultAlpn,
    });
  }

  function parseHysteria2(u) {
    needHostPort(u);
    const password = safeDecode(u.user || '');
    if (!password) fail('В ссылке Hysteria2 нет пароля');
    const p = u.params;
    const out = {
      type: 'hysteria2', server: u.host, server_port: u.port, password: password,
      tls: singTls(p, u.host, ['h3'])
    };
    if (p.obfs && p.obfs !== 'none') out.obfs = clean({ type: p.obfs, password: p['obfs-password'] || p.obfs_password });
    if (p.upmbps || p.up) out.up_mbps = parseInt(p.upmbps || p.up, 10) || undefined;
    if (p.downmbps || p.down) out.down_mbps = parseInt(p.downmbps || p.down, 10) || undefined;
    return clean(out);
  }

  function parseTuic(u) {
    needHostPort(u);
    const ui = safeDecode(u.user || '');
    const c = ui.indexOf(':');
    const uuid = c >= 0 ? ui.slice(0, c) : ui;
    const password = c >= 0 ? ui.slice(c + 1) : (u.params.password || '');
    if (!uuid) fail('В ссылке TUIC нет UUID');
    const p = u.params;
    return clean({
      type: 'tuic', server: u.host, server_port: u.port, uuid: uuid, password: password,
      congestion_control: p.congestion_control || p.congestion || 'bbr',
      udp_relay_mode: p.udp_relay_mode || undefined,
      tls: singTls(p, u.host, ['h3'])
    });
  }

  function parseAnyTls(u) {
    needHostPort(u);
    const password = safeDecode(u.user || '');
    if (!password) fail('В ссылке AnyTLS нет пароля');
    return { type: 'anytls', server: u.host, server_port: u.port, password: password, tls: singTls(u.params, u.host) };
  }

  function parseSsh(u) {
    needHostPort(u);
    const up = userPass(u);
    if (!up || !up.user) fail('В ссылке SSH нет пользователя');
    return clean({ type: 'ssh', server: u.host, server_port: u.port, user: up.user, password: up.pass || undefined });
  }

  function parseWireGuard(u) {
    needHostPort(u);
    const p = u.params;
    const privateKey = safeDecode(u.user || '') || p.privatekey || p.secretkey || p.private_key;
    const publicKey = p.publickey || p.public_key || p.peer_public_key;
    if (!privateKey) fail('В ссылке WireGuard нет приватного ключа');
    if (!publicKey) fail('В ссылке WireGuard нет публичного ключа сервера (publickey)');
    const address = splitList(p.address || p.ip || p.addresses) || ['10.0.0.2/32'];
    const peer = clean({
      address: u.host, port: u.port, public_key: publicKey,
      pre_shared_key: p.presharedkey || p.preshared_key || p.psk || undefined,
      allowed_ips: ['0.0.0.0/0', '::/0'],
      reserved: p.reserved ? p.reserved.split(',').map(function (x) { return parseInt(x, 10) || 0; }) : undefined,
      persistent_keepalive_interval: p.keepalive ? parseInt(p.keepalive, 10) : undefined
    });
    return clean({
      type: 'wireguard',
      address: address.map(function (a) { return a.indexOf('/') > 0 ? a : (a.indexOf(':') >= 0 ? a + '/128' : a + '/32'); }),
      private_key: privateKey,
      mtu: p.mtu ? parseInt(p.mtu, 10) : 1408,
      peers: [peer]
    });
  }

  const PROTO_TITLE = {
    vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks',
    socks: 'SOCKS5', http: 'HTTP-прокси', hysteria2: 'Hysteria2', tuic: 'TUIC',
    wireguard: 'WireGuard', anytls: 'AnyTLS', ssh: 'SSH'
  };

  /** Отличить подписку от http-прокси: у подписки есть путь или параметры */
  function isSubscriptionURL(s) {
    const m = /^https?:\/\/[^\/?#]+([\/?][^#]*)?/i.exec(s.trim());
    if (!m) return false;
    const tail = m[1] || '';
    return tail !== '' && tail !== '/';
  }

  /**
   * Разобрать ссылку на сервер.
   * @returns {{proto, title, name, address, port, outbound}}
   */
  function parseLink(link) {
    link = String(link || '').trim();
    const sm = /^([a-z0-9+.\-]+):\/\//i.exec(link);
    if (!sm) fail('Ссылка должна начинаться с vless://, vmess://, trojan://, ss://, hysteria2://, tuic://, wireguard://, anytls://, ssh://, socks:// или http://');
    const scheme = sm[1].toLowerCase();
    let outbound, endpoint = null, core = 'xray', name = '', host = '', port = 0;

    if (scheme === 'vless' || scheme === 'trojan') {
      const u = parseURL(link);
      outbound = scheme === 'vless' ? parseVless(u) : parseTrojan(u);
      name = u.name; host = u.host; port = u.port;
    } else if (scheme === 'vmess') {
      const r = parseVmess(link); outbound = r.out; name = r.name; host = r.host; port = r.port;
    } else if (scheme === 'ss') {
      const r = parseShadowsocks(link); outbound = r.out; name = r.name; host = r.host; port = r.port;
    } else if (scheme === 'socks' || scheme === 'socks5') {
      const u = parseURL(link); outbound = parseSocks(u); name = u.name; host = u.host; port = u.port;
    } else if (scheme === 'http' || scheme === 'https') {
      const u = parseURL(link); outbound = parseHttpProxy(u); name = u.name; host = u.host; port = u.port;
    } else if (scheme === 'hysteria2' || scheme === 'hy2') {
      const u = parseURL(link); outbound = parseHysteria2(u); core = 'sing-box'; name = u.name; host = u.host; port = u.port;
    } else if (scheme === 'tuic') {
      const u = parseURL(link); outbound = parseTuic(u); core = 'sing-box'; name = u.name; host = u.host; port = u.port;
    } else if (scheme === 'anytls') {
      const u = parseURL(link); outbound = parseAnyTls(u); core = 'sing-box'; name = u.name; host = u.host; port = u.port;
    } else if (scheme === 'ssh') {
      const u = parseURL(link); outbound = parseSsh(u); core = 'sing-box'; name = u.name; host = u.host; port = u.port;
    } else if (scheme === 'wireguard' || scheme === 'wg') {
      const u = parseURL(link); endpoint = parseWireGuard(u); core = 'sing-box'; name = u.name; host = u.host; port = u.port;
    } else if (/^(hysteria|naive\+https|naive\+quic)$/.test(scheme)) {
      fail('Протокол ' + scheme + ' пока не поддерживается');
    } else {
      fail('Неизвестный протокол: ' + scheme);
    }
    const proto = core === 'xray' ? outbound.protocol : (endpoint || outbound).type;
    return {
      proto: proto,
      core: core,
      title: PROTO_TITLE[proto] || proto,
      name: name || (PROTO_TITLE[proto] + ' ' + host + ':' + port),
      address: host,
      port: port,
      outbound: outbound || null,
      endpoint: endpoint
    };
  }

  /** Разобрать содержимое подписки → массив ссылок */
  function parseSubscription(text) {
    let t = String(text || '').trim();
    if (!t) fail('Подписка пустая');
    if (t.charAt(0) === '{' || t.charAt(0) === '[') fail('Подписка в формате JSON пока не поддерживается — нужен список ссылок');
    if (!/^[a-z0-9+.\-]+:\/\//im.test(t)) {
      try { t = b64decode(t); } catch (e) { fail('Не удалось расшифровать подписку'); }
    }
    const links = t.split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(function (l) { return /^[a-z0-9+.\-]+:\/\//i.test(l); });
    if (!links.length) fail('В подписке не найдено ни одной ссылки');
    return links;
  }

  /** Заголовок subscription-userinfo → объём и срок */
  function parseUserInfo(h) {
    if (!h) return null;
    const o = {};
    h.split(';').forEach(function (kv) {
      const p = kv.split('=');
      if (p.length === 2) o[p[0].trim()] = parseInt(p[1].trim(), 10) || 0;
    });
    return { upload: o.upload || 0, download: o.download || 0, total: o.total || 0, expire: o.expire || 0 };
  }

  /**
   * Конфигурация ядра: локальный SOCKS5 (с паролем) → выбранный сервер.
   * Порт 0 заменяет служебная программа на свободный порт.
   */
  function buildCoreConfig(outbound, creds) {
    return {
      log: { loglevel: 'warning' },
      inbounds: [{
        tag: 'local-in',
        listen: '127.0.0.1',
        port: 0,
        protocol: 'socks',
        settings: { auth: 'password', accounts: [{ user: creds.user, pass: creds.pass }], udp: false }
      }],
      outbounds: [
        Object.assign({ tag: 'proxy' }, outbound),
        { tag: 'direct', protocol: 'freedom' }
      ]
    };
  }

  /**
   * Конфигурация второго ядра (sing-box): локальный SOCKS5 с паролем → сервер.
   * Порт 0 заменяет служба браузера на свободный.
   */
  function buildSingboxConfig(parsed, creds) {
    const cfg = {
      log: { level: 'warn' },
      inbounds: [{ type: 'socks', tag: 'local-in', listen: '127.0.0.1', listen_port: 0,
        users: [{ username: creds.user, password: creds.pass }] }],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { final: 'proxy' }
    };
    if (parsed.endpoint) {
      // WireGuard работает на уровне IP: имена сайтов разрешаем через туннель, чтобы не было утечки DNS
      cfg.endpoints = [Object.assign({ tag: 'proxy' }, parsed.endpoint)];
      cfg.dns = { servers: [{ type: 'udp', tag: 'remote', server: '1.1.1.1', detour: 'proxy' }], final: 'remote' };
      cfg.route.default_domain_resolver = 'remote';
    } else {
      cfg.outbounds.unshift(Object.assign({ tag: 'proxy' }, parsed.outbound));
    }
    return cfg;
  }

  /** Конфигурация нужного ядра для разобранной ссылки */
  function buildConfig(parsed, creds) {
    if (parsed.core === 'sing-box') return { core: 'sing-box', config: buildSingboxConfig(parsed, creds) };
    return { core: 'xray', config: buildCoreConfig(parsed.outbound, creds) };
  }

  const api = {
    buildConfig: buildConfig,
    buildSingboxConfig: buildSingboxConfig,
    parseLink: parseLink, parseSubscription: parseSubscription, parseUserInfo: parseUserInfo,
    buildCoreConfig: buildCoreConfig, isSubscriptionURL: isSubscriptionURL, b64decode: b64decode
  };
  root.NCLinks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
