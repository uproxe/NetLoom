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
  // Значение в картах — одно правило или массив: большинство адресов встречается один раз,
  // а лишний массив на каждое правило стоит памяти.
  function Store() {
    this.hosts = new Map();   // host → rule | [rule]
    this.tokens = new Map();  // token → rule | [rule]
    this.generic = [];        // правила без токена
    this.count = 0;
  }
  Store.prototype.add = function (key, rule, map) {
    const cur = map.get(key);
    if (cur === undefined) map.set(key, rule);
    else if (Array.isArray(cur)) {
      if (rule === ANY && cur.indexOf(ANY) >= 0) return;
      cur.push(rule);
    } else if (cur === ANY && rule === ANY) return;
    else map.set(key, [cur, rule]);
    this.count++;
  };
  function testEntry(v, ctx) {
    if (!Array.isArray(v)) return v.test(ctx) ? v : null;
    for (let i = 0; i < v.length; i++) if (v[i].test(ctx)) return v[i];
    return null;
  }

  // хост или его родительский домен есть во множестве
  function inSet(host, set) {
    if (!set.size || !host) return false;
    return forEachSuffix(host, function (h) { return set.has(h); });
  }

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

  function Rule(src, mask, opts, isRegex) {
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
  // «||host^» без опций — самое частое правило: один общий объект на все
  const ANY = new Rule(null, ALL_TYPES, { thirdParty: undefined, inc: null, exc: null, important: false, matchCase: false });

  // ───────── Движок ─────────
  function Engine(opts) {
    this.validateSelector = (opts && opts.validateSelector) || null;
    this.block = new Store();
    this.allow = new Store();
    this.docAllow = new Set();          // @@…$document — сайт полностью без блокировки
    this.genericHideOff = new Set();    // @@…$generichide
    this.elemHideOff = new Set();       // @@…$elemhide
    this.genericSel = new Set();        // ##sel
    this.globalUnhide = new Set();      // #@#sel
    this.genericExc = new Map();        // domain → Set(sel) — не применять общий селектор на домене
    this.specific = new Map();          // domain → [{sel, exc}]
    this.specificExc = new Map();       // domain → Set(sel)
    this.skipped = 0;
  }

  Engine.prototype.addList = function (text) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) this.addLine(lines[i]);
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
        // чаще всего исключений нет — храним просто строку
        const item = d.exc.length ? { sel: sel, exc: d.exc } : sel;
        for (const dom of d.inc) {
          let list = this.specific.get(dom);
          if (!list) { list = []; this.specific.set(dom, list); }
          list.push(item);
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
      if (opts.special === 'document') this.docAllow.add(host);
      else if (opts.special === 'generichide') this.genericHideOff.add(host);
      else if (opts.special === 'elemhide') this.elemHideOff.add(host);
      return;
    }

    let mask = opts.mask || ALL_TYPES;
    if (opts.neg) mask &= ~opts.neg;
    if (!mask) { this.skipped++; return; }

    const store = exception ? this.allow : this.block;

    // /regex/
    if (pattern.length > 2 && pattern.charAt(0) === '/' && pattern.charAt(pattern.length - 1) === '/') {
      const src = pattern.slice(1, -1);
      try { new RegExp(src); } catch (e) { this.skipped++; return; }
      store.generic.push(new Rule(src, mask, opts, true)); store.count++;
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
        const plain = pure && mask === ALL_TYPES && opts.thirdParty === undefined && !opts.inc && !opts.exc && !opts.important;
        store.add(host, plain ? ANY : new Rule(pure ? null : patternToRegexSource(pattern), mask, opts), store.hosts);
        return;
      }
    }

    // общее правило с токеном
    let anchoredStart = false, anchoredEnd = false, body = pattern;
    if (body.startsWith('||')) { body = body.slice(2); anchoredStart = true; }
    else if (body.startsWith('|')) { body = body.slice(1); anchoredStart = true; }
    if (body.endsWith('|')) { body = body.slice(0, -1); anchoredEnd = true; }
    const token = bestToken(body.toLowerCase(), anchoredStart, anchoredEnd);
    const rule = new Rule(patternToRegexSource(pattern), mask, opts);
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
      const v = store.hosts.get(h);
      if (v !== undefined) found = testEntry(v, ctx);
      return found !== null;
    });
    if (found) return found;
    if (store.tokens.size) {
      const toks = ctx.tokens;
      for (let t = 0; t < toks.length; t++) {
        const v = store.tokens.get(toks[t]);
        if (v === undefined) continue;
        const r = testEntry(v, ctx);
        if (r) return r;
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
   * @returns {boolean} true — заблокировать
   */
  Engine.prototype.match = function (q) {
    const bit = WR_TYPES[q.type];
    if (!bit) return false; // основной документ не блокируем
    const host = (q.host || '').toLowerCase();
    const docHost = (q.docHost || '').toLowerCase();
    if (docHost && inSet(docHost, this.docAllow)) return false;
    const ctx = {
      url: q.url, urlLower: q.url.toLowerCase(), host: host, docHost: docHost, bit: bit,
      thirdParty: isThirdParty(host, docHost), tokens: null
    };
    ctx.tokens = urlTokens(ctx.urlLower);
    const b = findIn(this.block, ctx);
    if (!b) return false;
    return b.important || !findIn(this.allow, ctx);
  };

  Engine.prototype.isDocAllowed = function (host) {
    return inSet((host || '').toLowerCase(), this.docAllow);
  };

  // ───────── Косметика ─────────
  // Скрытие рекламы делится на две части:
  //  • общие правила (##.banner для всех сайтов) — одна небольшая таблица стилей на весь браузер;
  //    берём только «дешёвые» селекторы — с #id или .class в конце: движок стилей находит их по
  //    индексу, а селекторы по атрибутам проверялись бы на каждом элементе каждой страницы;
  //  • правила конкретных сайтов — только для открытой страницы (cosmeticFor), а не все сразу.
  // в селекторе не должно быть того, что закрывает правило или начинает новое
  const SAFE_SELECTOR = /^(?!.*\/\*)[^{};@]+$/;
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
  function cssString(s) { return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
  function hideRule(sel) { return sel + '{display:none!important}'; }

  /** Последняя часть селектора ищется по id или классу? */
  function cheapSelector(sel) {
    // содержимое [атрибутов] и (скобок) не учитываем: там бывают точки и пробелы
    const plain = sel.replace(/\[[^\]]*\]/g, '[]').replace(/\([^()]*\)/g, '()');
    const parts = plain.split(/\s*[>+~ ]\s*/);
    return /[#.][A-Za-z_\\-]/.test(parts[parts.length - 1]);
  }

  Engine.prototype.ok = function (sel) {
    return !this.globalUnhide.has(sel) && SAFE_SELECTOR.test(sel) && (!this.validateSelector || this.validateSelector(sel));
  };

  /** Общие селекторы для таблицы на весь браузер */
  Engine.prototype.genericSelectors = function () {
    const out = [];
    const self = this;
    this.genericSel.forEach(function (sel) { if (cheapSelector(sel) && self.ok(sel)) out.push(sel); });
    return out;
  };

  /** Сайты, где общие правила не применяются (у них есть исключения в списках) */
  Engine.prototype.genericExcludedDomains = function () {
    const s = new Set();
    this.genericExc.forEach(function (_, d) { s.add(d); });
    this.genericHideOff.forEach(function (d) { s.add(d); });
    this.elemHideOff.forEach(function (d) { s.add(d); });
    this.docAllow.forEach(function (d) { s.add(d); });
    return Array.from(s);
  };

  /** CSS общих правил одним блоком: все сайты, кроме исключённых и выбранных пользователем */
  Engine.prototype.genericStylesheet = function (opts) {
    const sels = this.genericSelectors();
    if (!sels.length) return '';
    const off = this.genericExcludedDomains().concat((opts && opts.allowlist) || [])
      .map(function (d) { return d.toLowerCase(); })
      .filter(function (d) { return /^[a-z0-9.-]+$/.test(d); });
    const cond = off.length
      ? 'regexp(' + cssString('https?:\\/\\/(?!(?:[^\\/?#]*\\.)?(?:' + Array.from(new Set(off)).map(escRe).join('|') + ')(?::\\d+)?[\\/?#]).*') + ')'
      : 'url-prefix("http://"), url-prefix("https://")';
    return '/* NetLoom: скрытие рекламы */\n@-moz-document ' + cond + ' {\n' + sels.map(hideRule).join('\n') + '\n}\n';
  };

  /**
   * CSS для одного сайта: его собственные правила. По правилу на селектор —
   * ошибка в одном не отключает остальные.
   */
  Engine.prototype.cosmeticFor = function (host) {
    host = (host || '').toLowerCase();
    if (!host || inSet(host, this.elemHideOff) || inSet(host, this.docAllow)) return '';
    const self = this;
    const unhide = new Set();
    forEachSuffix(host, function (h) {
      const a = self.specificExc.get(h); if (a) a.forEach(function (x) { unhide.add(x); });
      return false;
    });
    const sels = new Set();
    forEachSuffix(host, function (h) {
      const list = self.specific.get(h);
      if (!list) return false;
      for (const it of list) {
        const sel = typeof it === 'string' ? it : it.sel;
        if (typeof it !== 'string' && domainInList(host, it.exc)) continue;
        if (!unhide.has(sel) && self.ok(sel)) sels.add(sel);
      }
      return false;
    });
    let css = '';
    sels.forEach(function (sel) { css += hideRule(sel) + '\n'; });
    return css;
  };

  Engine.prototype.stats = function () {
    let specific = 0;
    this.specific.forEach(function (l) { specific += l.length; });
    return {
      network: this.block.count, exceptions: this.allow.count,
      cosmeticGeneric: this.genericSel.size, cosmeticSpecific: specific, skipped: this.skipped
    };
  };

  // ───────── Опасные сайты: список адресов ─────────
  // Списки malware-filter: строки «host», «||host^$all» и «||host/путь^$all».
  // Хранятся множеством строк — это в разы легче, чем правила общего движка.
  function HostList() {
    this.hosts = new Set();
    this.paths = new Map();   // host → [путь]
    this.count = 0;
  }
  HostList.prototype.add = function (text) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i].trim();
      const c = l.charAt(0);
      if (!l || c === '!' || c === '#' || c === '[') continue;
      l = l.replace(/^(0\.0\.0\.0|127\.0\.0\.1)\s+/, '');
      if (l.startsWith('@@')) continue;
      if (l.startsWith('||')) l = l.slice(2);
      const opt = l.indexOf('$');
      if (opt >= 0) l = l.slice(0, opt);
      l = l.replace(/\^\|?$/, '').toLowerCase();
      if (!l || l.indexOf('*') >= 0) continue;
      const slash = l.indexOf('/');
      if (slash < 0) { this.hosts.add(l); this.count++; continue; }
      const host = l.slice(0, slash);
      if (!host) continue;
      let list = this.paths.get(host);
      if (!list) { list = []; this.paths.set(host, list); }
      list.push(l.slice(slash));
      this.count++;
    }
  };
  HostList.prototype.match = function (url, host) {
    host = (host || '').toLowerCase();
    if (!host) return false;
    if (inSet(host, this.hosts)) return true;
    const list = this.paths.get(host);
    if (!list) return false;
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^\/?#]*(.*)$/i.exec(url);
    const path = m ? m[1].toLowerCase() : '';
    for (let i = 0; i < list.length; i++) if (path.startsWith(list[i])) return true;
    return false;
  };

  const api = {
    Engine: Engine, HostList: HostList, baseDomain: baseDomain, isThirdParty: isThirdParty,
    hostMatches: hostMatches, domainInList: domainInList, patternToRegexSource: patternToRegexSource
  };
  root.NCFilters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
