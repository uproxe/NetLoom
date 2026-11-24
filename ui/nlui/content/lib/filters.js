/*
 * NetLoom — движок блокировки рекламы.
 * Понимает синтаксис списков фильтров формата Adblock (EasyList, RU AdList, EasyPrivacy):
 *   сетевые правила  ||host^, |http://…, /regex/, *, ^, исключения @@, опции $…
 *   косметика        ##selector, domain##selector, #@# исключения
 * Расширенный синтаксис (скриптлеты, :has-text и т.п.) пока пропускается.
 */
(function (root) {
  'use strict';

  // ───────── Типы запросов ─────────
  const T = {
    subdocument: 1, script: 2, image: 4, stylesheet: 8, object: 16,
    xmlhttprequest: 32, ping: 64, media: 128, font: 256, websocket: 512, other: 1024
  };
  const ALL_TYPES = 2047;

  // webRequest type → бит
  const WR_TYPES = {
    sub_frame: T.subdocument, script: T.script, image: T.image, imageset: T.image,
    stylesheet: T.stylesheet, object: T.object, object_subrequest: T.object,
    xmlhttprequest: T.xmlhttprequest, ping: T.ping, beacon: T.ping, media: T.media,
    font: T.font, websocket: T.websocket, csp_report: T.other, web_manifest: T.other,
    xslt: T.other, xml_dtd: T.other, speculative: T.other, other: T.other
  };

  // опция фильтра → бит
  const OPT_TYPES = {
    script: T.script, image: T.image, stylesheet: T.stylesheet, css: T.stylesheet,
    object: T.object, 'object-subrequest': T.object, xmlhttprequest: T.xmlhttprequest,
    xhr: T.xmlhttprequest, subdocument: T.subdocument, frame: T.subdocument,
    ping: T.ping, beacon: T.ping, media: T.media, font: T.font,
    websocket: T.websocket, other: T.other
  };

  // Опции, которые мы не умеем выполнять корректно: правило пропускаем, чтобы не сломать сайты
  const UNSUPPORTED_OPTS = new Set([
    'csp', 'redirect', 'redirect-rule', 'removeparam', 'queryprune', 'rewrite', 'replace',
    'header', 'permissions', 'to', 'method', 'denyallow', 'popup', 'popunder', 'cname',
    'inline-script', 'inline-font', 'webrtc', 'genericblock', 'sitekey', 'empty', 'mp4',
    'specifichide', 'shide', 'badfilter', 'jsonprune', 'urltransform', 'urlskip', 'uritransform',
    'stealth', 'cookie', 'network', 'app', 'content', 'extension', 'jsinject', 'urlblock',
    'hls', 'referrerpolicy', 'strict1p', 'strict3p'
  ]);

  // ───────── Домены ─────────
  const MULTI_SLD = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp',
    'or.jp', 'com.br', 'com.cn', 'net.cn', 'org.cn', 'com.tr', 'com.ua', 'org.ua', 'net.ua',
    'kiev.ua', 'co.il', 'co.kr', 'co.in', 'co.za', 'com.mx', 'com.ar', 'com.sg', 'com.hk',
    'com.tw', 'co.nz', 'msk.ru', 'spb.ru', 'com.ru', 'net.ru', 'org.ru', 'pp.ru', 'msk.su',
    'spb.su', 'com.kz', 'org.kz', 'com.by', 'github.io', 'blogspot.com', 'appspot.com',
    'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'narod.ru',
    'ucoz.ru', 'cloudfront.net', 'azurewebsites.net'
  ]);
  const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

  function baseDomain(host) {
    if (!host || IPV4.test(host) || host.indexOf(':') >= 0) return host;
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const last2 = parts.slice(-2).join('.');
    return MULTI_SLD.has(last2) ? parts.slice(-3).join('.') : last2;
  }

  function isThirdParty(reqHost, docHost) {
    if (!docHost) return false;
    return baseDomain(reqHost) !== baseDomain(docHost);
  }

  // host совпадает с domain или является его поддоменом
  function hostMatches(host, domain) {
    if (host === domain) return true;
    return host.length > domain.length &&
      host.charCodeAt(host.length - domain.length - 1) === 46 /* . */ &&
      host.endsWith(domain);
  }

  function domainInList(host, list) {
    for (let i = 0; i < list.length; i++) if (hostMatches(host, list[i])) return true;
    return false;
  }

  // перебор суффиксов: a.b.c.com → a.b.c.com, b.c.com, c.com, com
  function forEachSuffix(host, fn) {
    let h = host;
    while (h) {
      if (fn(h)) return true;
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    return false;
  }

  // ───────── Преобразование шаблона в RegExp ─────────
  const RE_SPECIAL = /[.+?${}()|[\]\\\/]/;

  function patternToRegexSource(p) {
    let prefix = '', suffix = '', start = 0, end = p.length;
    if (p.startsWith('||')) { prefix = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]*\\.)?'; start = 2; }
    else if (p.startsWith('|')) { prefix = '^'; start = 1; }
    if (end > start && p.charAt(end - 1) === '|') { suffix = '$'; end--; }
    let src = '';
    for (let i = start; i < end; i++) {
      const c = p.charAt(i);
      if (c === '*') { if (!src.endsWith('.*')) src += '.*'; }
      else if (c === '^') src += '(?:[^\\w\\-.%]|$)';
      else if (RE_SPECIAL.test(c)) src += '\\' + c;
      else src += c;
    }
    return prefix + src + suffix;
  }

  // ───────── Токены для быстрого поиска ─────────
  const BAD_TOKENS = new Set(['http', 'https', 'www', 'com', 'net', 'org', 'html', 'js', 'php']);

  function bestToken(p, anchoredStart, anchoredEnd) {
    const re = /[a-z0-9%]{2,}/g;
    let best = '', bestScore = 0, m;
    while ((m = re.exec(p)) !== null) {
      const s = m.index, e = s + m[0].length;
      if (s === 0 ? !anchoredStart : p.charAt(s - 1) === '*') continue;
      if (e === p.length ? !anchoredEnd : p.charAt(e) === '*') continue;
      const score = BAD_TOKENS.has(m[0]) ? 1 : m[0].length + 1;
      if (score > bestScore) { best = m[0]; bestScore = score; }
    }
    return best;
  }

  // ───────── Опции ─────────
  function splitOptions(line) {
    const i = line.lastIndexOf('$');
    if (i <= 0) return [line, null];
    const opts = line.slice(i + 1);
    // regex-правило вида /…$/ без опций
    if (line.startsWith('/') && line.endsWith('/')) return [line, null];
    if (!/^[\w~,=\-.|*%]+$/i.test(opts) && opts.indexOf('domain=') < 0) return [line, null];
    return [line.slice(0, i), opts];
  }

  function parseDomainList(str, sep) {
    const inc = [], exc = [];
    str.split(sep).forEach(function (d) {
      d = d.trim().toLowerCase();
      if (!d) return;
      if (d.charAt(0) === '~') exc.push(d.slice(1)); else inc.push(d);
    });
    return { inc: inc, exc: exc };
  }

  function parseOptions(str) {
    const o = { mask: 0, neg: 0, thirdParty: undefined, inc: null, exc: null,
      important: false, matchCase: false, special: null, unsupported: false };
    const parts = str.split(',');
    for (let k = 0; k < parts.length; k++) {
      let opt = parts[k].trim().toLowerCase();
      if (!opt) continue;
      let negated = false;
      if (opt.charAt(0) === '~') { negated = true; opt = opt.slice(1); }
      const eq = opt.indexOf('=');
      const name = eq >= 0 ? opt.slice(0, eq) : opt;
      const value = eq >= 0 ? parts[k].trim().slice(parts[k].trim().indexOf('=') + 1) : '';

      if (OPT_TYPES[name]) { if (negated) o.neg |= OPT_TYPES[name]; else o.mask |= OPT_TYPES[name]; }
      else if (name === 'third-party' || name === '3p') o.thirdParty = !negated;
      else if (name === 'first-party' || name === '1p') o.thirdParty = negated;
      else if (name === 'domain' || name === 'from') {
        const d = parseDomainList(value, '|');
        if (d.inc.some(isEntity) || d.exc.some(isEntity)) { o.unsupported = true; }
        o.inc = d.inc.length ? d.inc : null; o.exc = d.exc.length ? d.exc : null;
      }
      else if (name === 'important') o.important = true;
      else if (name === 'match-case') o.matchCase = true;
      else if (name === 'all') o.mask |= ALL_TYPES;
      else if (name === 'document' || name === 'doc') o.special = 'document';
      else if (name === 'elemhide' || name === 'ehide') o.special = 'elemhide';
      else if (name === 'generichide' || name === 'ghide') o.special = 'generichide';
      else if (UNSUPPORTED_OPTS.has(name)) o.unsupported = true;
      else o.unsupported = true; // неизвестная опция — безопаснее пропустить
    }
    return o;
  }

  function isEntity(d) { return d.indexOf('*') >= 0 || d.charAt(0) === '/'; }

  // ───────── Хранилище правил ─────────
  function Store() {
    this.hosts = new Map();   // host → [rule]
    this.tokens = new Map();  // token → [rule]
    this.generic = [];        // правила без токена
    this.count = 0;
  }
  Store.prototype.add = function (key, rule, map) {
    let list = map.get(key);
    if (!list) { list = []; map.set(key, list); }
    list.push(rule);
    this.count++;
  };

  // Обязательный кусок текста из regex — быстрая проверка до запуска самого regex
  function regexLiteral(src) {
    if (/(^|[^\\])\|/.test(src)) return '';
    let best = '', run = '', depth = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src.charAt(i);
      if (c === '\\') { if (run.length > best.length) best = run; run = ''; i++; continue; }
      if (c === '[') { if (run.length > best.length) best = run; run = ''; const e = src.indexOf(']', i + 1); i = e < 0 ? src.length : e; continue; }
      if (c === '(') { depth++; if (run.length > best.length) best = run; run = ''; continue; }
      if (c === ')') { depth = Math.max(0, depth - 1); run = ''; continue; }
      if (depth === 0 && /[a-z0-9%]/i.test(c)) { run += c.toLowerCase(); continue; }
      if (c === '?' || c === '*' || c === '{') run = run.slice(0, -1);
      if (run.length > best.length) best = run;
      run = '';
    }
    if (run.length > best.length) best = run;
    return best.length >= 3 ? best : '';
  }

  function Rule(text, src, mask, opts, isRegex) {
    this.text = text;
    this.lit = isRegex ? regexLiteral(src) : '';
    this.src = src;          // исходник regex (компилируется лениво) или null
    this.re = null;
    this.mask = mask;
    this.tp = opts.thirdParty;
    this.inc = opts.inc;
    this.exc = opts.exc;
    this.important = opts.important;
    this.flags = opts.matchCase ? '' : 'i';
  }
  Rule.prototype.test = function (ctx) {
    if ((this.mask & ctx.bit) === 0) return false;
    if (this.tp !== undefined && this.tp !== ctx.thirdParty) return false;
    if (this.inc && !(ctx.docHost && domainInList(ctx.docHost, this.inc))) return false;
    if (this.exc && ctx.docHost && domainInList(ctx.docHost, this.exc)) return false;
    if (this.src === null) return true;
    if (this.lit && ctx.urlLower.indexOf(this.lit) < 0) return false;
    if (this.re === null) {
      try { this.re = new RegExp(this.src, this.flags); }
      catch (e) { this.re = /(?!)/; }
    }
    return this.re.test(ctx.url);
  };

  // ───────── Движок ─────────
  function Engine(opts) {
    this.validateSelector = (opts && opts.validateSelector) || null;
    this.block = new Store();
    this.allow = new Store();
    this.docAllow = [];                 // @@…$document — сайт полностью без блокировки
    this.genericHideOff = new Set();    // @@…$generichide
    this.elemHideOff = new Set();       // @@…$elemhide
    this.genericSel = new Set();        // ##sel
    this.globalUnhide = new Set();      // #@#sel
    this.genericExc = new Map();        // domain → Set(sel) — не применять общий селектор на домене
    this.specific = new Map();          // domain → [{sel, exc}]
    this.specificExc = new Map();       // domain → Set(sel)
    this.skipped = 0;
    this._genericCSS = null;
  }

  Engine.prototype.addList = function (text) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) this.addLine(lines[i]);
    this._genericCSS = null;
  };

  /**
   * Несколько списков сразу (EasyList, AdGuard…). Правила с $badfilter из любого
   * списка отключают совпадающие правила во всех остальных.
   */
  Engine.prototype.addLists = function (texts) {
    const bad = new Set();
    const all = texts.map(function (t) { return t.split(/\r?\n/); });
    for (const lines of all) {
      for (const raw of lines) {
        if (raw.indexOf('badfilter') < 0) continue;
        const line = raw.trim();
        const i = line.lastIndexOf('$');
        if (i < 0) continue;
        const opts = line.slice(i + 1).split(',').filter(function (o) { return o.trim() !== 'badfilter'; });
        bad.add(opts.length ? line.slice(0, i) + '$' + opts.join(',') : line.slice(0, i));
      }
    }
    this.badfiltered = 0;
    for (const lines of all) {
      for (const raw of lines) {
        const line = raw.trim();
        if (bad.size && bad.has(line)) { this.badfiltered++; continue; }
        this.addLine(line);
      }
    }
    this._genericCSS = null;
  };

  const COSMETIC_SEP = /^([^\s#]*?)(#@?[?$%]?#)(.+)$/;
  const EXT_SELECTOR = /:-abp-|:has-text\(|:contains\(|:xpath\(|:upward\(|:remove\(|:style\(|:matches-css|:min-text-length|:watch-attr|:others\(|:matches-path|:matches-attr|:matches-prop|:matches-media|:if\(|:if-not\(|:nth-ancestor|:-ext-|:remove-attr|:remove-class/;

  Engine.prototype.addLine = function (raw) {
    const line = raw.trim();
    if (!line || line.charAt(0) === '!' || line.charAt(0) === '[' || line.startsWith('# ')) return;

    // косметика?
    if (line.indexOf('#') >= 0) {
      const m = COSMETIC_SEP.exec(line);
      if (m) { this.addCosmetic(m[1], m[2], m[3].trim()); return; }
    }
    if (line.indexOf('$$') >= 0 || line.indexOf('$@$') >= 0) { this.skipped++; return; }
    this.addNetwork(line);
  };

  Engine.prototype.addCosmetic = function (domainsStr, sep, sel) {
    if (sep !== '##' && sep !== '#@#') { this.skipped++; return; }
    if (sel.startsWith('+js(') || sel.charAt(0) === '^' || EXT_SELECTOR.test(sel)) { this.skipped++; return; }
    const d = parseDomainList(domainsStr, ',');
    const hadInc = d.inc.length > 0;
    d.inc = d.inc.filter(function (x) { return !isEntity(x); });
    d.exc = d.exc.filter(function (x) { return !isEntity(x); });
    if (hadInc && d.inc.length === 0) { this.skipped++; return; }

    if (sep === '##') {
      if (d.inc.length === 0) {
        this.genericSel.add(sel);
        for (const ex of d.exc) addToSetMap(this.genericExc, ex, sel);
      } else {
        for (const dom of d.inc) {
          let list = this.specific.get(dom);
          if (!list) { list = []; this.specific.set(dom, list); }
          list.push({ sel: sel, exc: d.exc.length ? d.exc : null });
        }
      }
    } else {
      if (d.inc.length === 0) this.globalUnhide.add(sel);
      else for (const dom of d.inc) {
        addToSetMap(this.genericExc, dom, sel);
        addToSetMap(this.specificExc, dom, sel);
      }
    }
  };

  function addToSetMap(map, key, val) {
    let s = map.get(key);
    if (!s) { s = new Set(); map.set(key, s); }
    s.add(val);
  }

  Engine.prototype.addNetwork = function (line) {
    let exception = false;
    if (line.startsWith('@@')) { exception = true; line = line.slice(2); }
    const so = splitOptions(line);
    let pattern = so[0];
    const opts = so[1] ? parseOptions(so[1]) : parseOptions('');
    if (opts.unsupported) { this.skipped++; return; }

    // особые исключения уровня страницы
    if (opts.special) {
      if (!exception) { this.skipped++; return; } // блокировать документы целиком не умеем
      const host = pureHost(pattern);
      if (!host) { this.skipped++; return; }
      if (opts.special === 'document') this.docAllow.push(host);
      else if (opts.special === 'generichide') this.genericHideOff.add(host);
      else if (opts.special === 'elemhide') this.elemHideOff.add(host);
      return;
    }

    let mask = opts.mask || ALL_TYPES;
    if (opts.neg) mask &= ~opts.neg;
    if (!mask) { this.skipped++; return; }

    const store = exception ? this.allow : this.block;
    const text = (exception ? '@@' : '') + line;

    // /regex/
    if (pattern.length > 2 && pattern.charAt(0) === '/' && pattern.charAt(pattern.length - 1) === '/') {
      const src = pattern.slice(1, -1);
      try { new RegExp(src); } catch (e) { this.skipped++; return; }
      store.generic.push(new Rule(text, src, mask, opts, true)); store.count++;
      return;
    }

    // убираем лишние звёздочки по краям
    while (pattern.startsWith('*')) pattern = pattern.slice(1);
    while (pattern.endsWith('*') && !pattern.endsWith('\\*')) pattern = pattern.slice(0, -1);
    if (!pattern || pattern === '|' || pattern === '||') {
      if (!opts.inc && opts.thirdParty === undefined && !exception) { this.skipped++; return; } // «блокировать всё» не берём
    }

    // ||host^…
    if (pattern.startsWith('||')) {
      const rest = pattern.slice(2);
      const hm = /^[a-z0-9\-._%]+/i.exec(rest);
      const host = hm ? hm[0].toLowerCase() : '';
      const after = rest.slice(host.length);
      if (host && host.indexOf('.') > 0 && !host.endsWith('.') && !after.startsWith('*') &&
          (after === '' || /^[\^\/:?|]/.test(after))) {
        const pure = after === '' || after === '^' || after === '^|' || after === '|';
        const src = pure ? null : patternToRegexSource(pattern);
        store.add(host, new Rule(text, src, mask, opts), store.hosts);
        return;
      }
    }

    // общее правило с токеном
    let anchoredStart = false, anchoredEnd = false, body = pattern;
    if (body.startsWith('||')) { body = body.slice(2); anchoredStart = true; }
    else if (body.startsWith('|')) { body = body.slice(1); anchoredStart = true; }
    if (body.endsWith('|')) { body = body.slice(0, -1); anchoredEnd = true; }
    const token = bestToken(body.toLowerCase(), anchoredStart, anchoredEnd);
    const rule = new Rule(text, patternToRegexSource(pattern), mask, opts);
    if (token) store.add(token, rule, store.tokens);
    else { store.generic.push(rule); store.count++; }
  };

  function pureHost(pattern) {
    const m = /^\|\|([a-z0-9\-._]+)\^?\|?$/i.exec(pattern);
    return m ? m[1].toLowerCase() : null;
  }

  function findIn(store, ctx) {
    let found = null;
    forEachSuffix(ctx.host, function (h) {
      const list = store.hosts.get(h);
      if (!list) return false;
      for (let i = 0; i < list.length; i++) if (list[i].test(ctx)) { found = list[i]; return true; }
      return false;
    });
    if (found) return found;
    if (store.tokens.size) {
      const toks = ctx.tokens;
      for (let t = 0; t < toks.length; t++) {
        const list = store.tokens.get(toks[t]);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) if (list[i].test(ctx)) return list[i];
      }
    }
    for (let i = 0; i < store.generic.length; i++) if (store.generic[i].test(ctx)) return store.generic[i];
    return null;
  }

  function urlTokens(url) {
    const m = url.match(/[a-z0-9%]{2,}/g) || [];
    return Array.from(new Set(m));
  }

  /**
   * Проверить запрос.
   * @param {object} q { url, host, type (webRequest type), docHost }
   * @returns {null | {rule:string}}  null — пропустить, объект — заблокировать
   */
  Engine.prototype.match = function (q) {
    const bit = WR_TYPES[q.type];
    if (!bit) return null; // основной документ не блокируем
    const host = (q.host || '').toLowerCase();
    const docHost = (q.docHost || '').toLowerCase();
    if (docHost && domainInList(docHost, this.docAllow)) return null;
    const ctx = {
      url: q.url, urlLower: q.url.toLowerCase(), host: host, docHost: docHost, bit: bit,
      thirdParty: isThirdParty(host, docHost), tokens: null
    };
    ctx.tokens = urlTokens(ctx.urlLower);
    const b = findIn(this.block, ctx);
    if (!b) return null;
    if (!b.important && findIn(this.allow, ctx)) return null;
    return { rule: b.text };
  };

  Engine.prototype.isDocAllowed = function (host) {
    return !!host && domainInList(host.toLowerCase(), this.docAllow);
  };

  // ───────── Косметика ─────────
  function cssFromSelectors(sels) {
    const out = [];
    for (let i = 0; i < sels.length; i += 100) {
      out.push(sels.slice(i, i + 100).join(',\n') + '{display:none!important}');
    }
    return out.join('\n');
  }

  Engine.prototype.genericSelectors = function () {
    const self = this;
    return Array.from(this.genericSel).filter(function (s) {
      if (self.globalUnhide.has(s)) return false;
      return !self.validateSelector || self.validateSelector(s);
    });
  };

  /** CSS общих селекторов — регистрируется один раз для всех сайтов */
  Engine.prototype.genericCSS = function () {
    if (this._genericCSS === null) this._genericCSS = cssFromSelectors(this.genericSelectors());
    return this._genericCSS;
  };

  /** Домены, где общий CSS нельзя применять целиком */
  Engine.prototype.genericExcludedDomains = function () {
    const s = new Set();
    this.genericExc.forEach(function (_, d) { s.add(d); });
    this.genericHideOff.forEach(function (d) { s.add(d); });
    this.elemHideOff.forEach(function (d) { s.add(d); });
    this.docAllow.forEach(function (d) { s.add(d); });
    return Array.from(s);
  };

  /**
   * CSS для конкретного сайта.
   * @param {string} host
   * @param {boolean} genericExcluded — сайт в списке исключений общего CSS (тогда общий CSS добавляется сюда, отфильтрованным)
   */
  Engine.prototype.cosmeticFor = function (host, genericExcluded) {
    host = (host || '').toLowerCase();
    if (!host) return '';
    if (domainInList(host, Array.from(this.elemHideOff)) || this.isDocAllowed(host)) return '';
    const self = this;
    const unhideSpecific = new Set();
    const unhideGeneric = new Set();
    forEachSuffix(host, function (h) {
      const a = self.specificExc.get(h); if (a) a.forEach(function (x) { unhideSpecific.add(x); });
      const b = self.genericExc.get(h); if (b) b.forEach(function (x) { unhideGeneric.add(x); });
      return false;
    });
    const sels = [];
    forEachSuffix(host, function (h) {
      const list = self.specific.get(h);
      if (!list) return false;
      for (const it of list) {
        if (unhideSpecific.has(it.sel) || self.globalUnhide.has(it.sel)) continue;
        if (it.exc && domainInList(host, it.exc)) continue;
        if (self.validateSelector && !self.validateSelector(it.sel)) continue;
        sels.push(it.sel);
      }
      return false;
    });
    if (genericExcluded && !domainInList(host, Array.from(this.genericHideOff))) {
      for (const s of this.genericSelectors()) if (!unhideGeneric.has(s)) sels.push(s);
    }
    return sels.length ? cssFromSelectors(Array.from(new Set(sels))) : '';
  };

  // ───────── Пользовательская таблица стилей для всего браузера ─────────
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
  function cssString(s) { return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
  const HOST_PREFIX = '(?:[^\\/?#]*\\.)?';
  const HOST_END = '(?::\\d+)?[\\/?#]';
  function notHosts(domains) {
    return domains.length ? '(?!' + HOST_PREFIX + '(?:' + domains.map(escRe).join('|') + ')' + HOST_END + ')' : '';
  }
  /** @-moz-document: все http(s)-страницы, кроме доменов (и их поддоменов) */
  function condExcept(domains) {
    if (!domains.length) return 'url-prefix("http://"), url-prefix("https://")';
    return 'regexp(' + cssString('https?:\\/\\/' + notHosts(domains) + '.*') + ')';
  }
  /** @-moz-document: домен и поддомены, кроме исключённых */
  function condDomain(domain, except) {
    if (!except.length) return 'domain(' + cssString(domain) + ')';
    return 'regexp(' + cssString('https?:\\/\\/' + notHosts(except) + HOST_PREFIX + escRe(domain) + HOST_END + '.*') + ')';
  }
  function uniq(a) { return Array.from(new Set(a)); }
  const SAFE_SELECTOR = /^[^{}<>;@]+$/;
  function hideRule(sel) { return sel + '{display:none!important}'; }

  /**
   * Вся косметика одной таблицей стилей (USER_SHEET).
   * @param {{allowlist?: string[]}} opts allowlist — сайты, где пользователь выключил блокировку
   */
  Engine.prototype.userStylesheet = function (opts) {
    const self = this;
    const allow = ((opts && opts.allowlist) || []).map(function (d) { return d.toLowerCase(); });
    const offAll = uniq(Array.from(this.elemHideOff).concat(this.docAllow, allow));
    const offGeneric = uniq(offAll.concat(Array.from(this.genericHideOff)));
    const ok = function (sel) {
      return SAFE_SELECTOR.test(sel) && (!self.validateSelector || self.validateSelector(sel));
    };
    const out = ['/* NetLoom: скрытие рекламы */'];

    // общие селекторы; те, у которых есть исключения на отдельных сайтах, — отдельными блоками
    const excBySel = new Map();
    this.genericExc.forEach(function (sels, dom) {
      sels.forEach(function (sel) {
        let l = excBySel.get(sel);
        if (!l) { l = []; excBySel.set(sel, l); }
        l.push(dom);
      });
    });
    const plain = [];
    Array.from(this.genericSel).forEach(function (sel) {
      if (self.globalUnhide.has(sel) || !ok(sel)) return;
      if (excBySel.has(sel)) {
        out.push('@-moz-document ' + condExcept(uniq(offGeneric.concat(excBySel.get(sel)))) + ' {\n' + hideRule(sel) + '\n}');
      } else {
        plain.push(hideRule(sel));
      }
    });
    if (plain.length) out.push('@-moz-document ' + condExcept(offGeneric) + ' {\n' + plain.join('\n') + '\n}');

    // правила для конкретных сайтов
    this.specific.forEach(function (list, dom) {
      if (domainInList(dom, offAll)) return;
      const unhide = new Set();
      forEachSuffix(dom, function (h) {
        const x = self.specificExc.get(h);
        if (x) x.forEach(function (s) { unhide.add(s); });
        return false;
      });
      const subOff = offAll.filter(function (d) { return d !== dom && hostMatches(d, dom); });
      const groups = new Map();
      for (const it of list) {
        if (unhide.has(it.sel) || self.globalUnhide.has(it.sel) || !ok(it.sel)) continue;
        const key = it.exc ? it.exc.slice().sort().join(',') : '';
        let g = groups.get(key);
        if (!g) { g = { exc: it.exc || [], rules: [] }; groups.set(key, g); }
        g.rules.push(hideRule(it.sel));
      }
      groups.forEach(function (g) {
        out.push('@-moz-document ' + condDomain(dom, uniq(g.exc.concat(subOff))) + ' {\n' + uniq(g.rules).join('\n') + '\n}');
      });
    });
    return out.join('\n');
  };

  Engine.prototype.stats = function () {
    let specific = 0;
    this.specific.forEach(function (l) { specific += l.length; });
    return {
      network: this.block.count, exceptions: this.allow.count,
      cosmeticGeneric: this.genericSel.size, cosmeticSpecific: specific, skipped: this.skipped
    };
  };

  const api = {
    Engine: Engine, baseDomain: baseDomain, isThirdParty: isThirdParty,
    hostMatches: hostMatches, domainInList: domainInList, patternToRegexSource: patternToRegexSource
  };
  root.NCFilters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
