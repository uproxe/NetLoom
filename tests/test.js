// Тесты логики модуля: node tests/test.js
'use strict';
const assert = require('assert');
const F = require('../ui/nlui/content/lib/filters.js');
const L = require('../ui/nlui/content/lib/links.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error('✗ ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

// ───────── фильтры ─────────
const LIST = `[Adblock Plus 2.0]
! комментарий
||ads.example.com^
||tracker.net^$third-party
||cdn.site.com/banners/
/adframe.
&ad_type=
@@||ads.example.com/allowed/
||only-scripts.com^$script
||not-images.com^$~image
||scoped.com^$domain=news.ru|~sport.news.ru
||important.com^$important
@@||important.com^
@@||goodsite.org^$document
@@||nogeneric.org^$generichide
/banner\\d+\\.gif/
||weird.com^$csp=script-src 'none'
##.ad-banner
##div[id^="google_ads"]
~nohide.com##.ad-banner
example.org##.sponsored
example.org,~sub.example.org##.promo
example.org#@#.ad-banner
#@#.harmless
##.harmless
##.bad:has-text(Реклама)
##+js(nobab)
`;

const eng = new F.Engine();
eng.addList(LIST);
const m = function (url, type, docHost) {
  return eng.match({ url: url, host: new URL(url).hostname, type: type || 'script', docHost: docHost || 'page.com' });
};

test('блокировка по домену и поддомену', function () {
  assert(m('https://ads.example.com/x.js'));
  assert(m('https://img.ads.example.com/x.png', 'image'));
  assert(!m('https://notads.example.com/x.js'));
  assert(!m('https://ads.example.com.evil.net/x.js'));
});
test('исключение @@ по пути', function () {
  assert(!m('https://ads.example.com/allowed/a.js'));
});
test('$third-party', function () {
  assert(m('https://tracker.net/p.gif', 'image', 'page.com'));
  assert(!m('https://tracker.net/p.gif', 'image', 'www.tracker.net'));
});
test('правило с путём', function () {
  assert(m('https://cdn.site.com/banners/1.jpg', 'image'));
  assert(!m('https://cdn.site.com/images/1.jpg', 'image'));
});
test('общие правила с токенами', function () {
  assert(m('https://x.com/adframe.html', 'sub_frame'));
  assert(m('https://x.com/p?id=1&ad_type=2', 'xmlhttprequest'));
  assert(!m('https://x.com/frame.html', 'sub_frame'));
});
test('типы запросов', function () {
  assert(m('https://only-scripts.com/a.js', 'script'));
  assert(!m('https://only-scripts.com/a.png', 'image'));
  assert(m('https://not-images.com/a.js', 'script'));
  assert(!m('https://not-images.com/a.png', 'image'));
});
test('$domain=', function () {
  assert(m('https://scoped.com/a.js', 'script', 'news.ru'));
  assert(m('https://scoped.com/a.js', 'script', 'www.news.ru'));
  assert(!m('https://scoped.com/a.js', 'script', 'sport.news.ru'));
  assert(!m('https://scoped.com/a.js', 'script', 'other.ru'));
});
test('$important сильнее исключения', function () {
  assert(m('https://important.com/a.js'));
});
test('$document выключает блокировку на сайте', function () {
  assert(!m('https://ads.example.com/x.js', 'script', 'goodsite.org'));
  assert(eng.isDocAllowed('www.goodsite.org'));
});
test('regex-правило', function () {
  assert(m('https://x.com/img/banner123.gif', 'image'));
  assert(!m('https://x.com/img/bannerX.gif', 'image'));
});
test('неподдерживаемые опции пропускаются', function () {
  assert(!m('https://weird.com/a.js'));
});
test('главный документ не блокируется', function () {
  assert(!m('https://ads.example.com/', 'main_frame'));
});
test('косметика: общий CSS', function () {
  const css = eng.genericCSS();
  assert(css.indexOf('.ad-banner') >= 0);
  assert(css.indexOf('google_ads') >= 0);
  assert(css.indexOf('has-text') < 0, 'расширенный синтаксис не должен попадать');
  assert(css.indexOf('.harmless') < 0, 'глобальное исключение #@#');
  assert(css.indexOf('display:none!important') > 0);
});
test('косметика: исключённые домены', function () {
  const ex = eng.genericExcludedDomains();
  ['nohide.com', 'example.org', 'nogeneric.org', 'goodsite.org'].forEach(function (d) { assert(ex.indexOf(d) >= 0, d); });
});
test('косметика: сайт со своими правилами', function () {
  const css = eng.cosmeticFor('www.example.org', true);
  assert(css.indexOf('.sponsored') >= 0);
  assert(css.indexOf('.promo') >= 0);
  assert(css.indexOf('.ad-banner') < 0, 'example.org#@#.ad-banner');
  assert(css.indexOf('google_ads') >= 0, 'остальные общие селекторы применяются');
  const sub = eng.cosmeticFor('sub.example.org', true);
  assert(sub.indexOf('.promo') < 0);
  assert.strictEqual(eng.cosmeticFor('nogeneric.org', true), '');
  assert.strictEqual(eng.cosmeticFor('plain.com', false), '');
});
test('базовый домен', function () {
  assert.strictEqual(F.baseDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.strictEqual(F.baseDomain('news.yandex.ru'), 'yandex.ru');
  assert.strictEqual(F.baseDomain('a.msk.ru'), 'a.msk.ru');
});
test('шаблон → regex', function () {
  const re = new RegExp(F.patternToRegexSource('||ex.com^*/ads/'), 'i');
  assert(re.test('https://ex.com/x/ads/1'));
  assert(re.test('https://sub.ex.com/p/ads/1'));
  assert(!re.test('https://ex.community/ads/1'));
});

test('несколько списков и $badfilter', function () {
  const e = new F.Engine();
  e.addLists(['||ads.one.com^\n||keep.com^$script\n##.banner', '||ads.one.com^$badfilter\n||two.net^$third-party']);
  const q = function (url, docHost) { return e.match({ url: url, host: new URL(url).hostname, type: 'script', docHost: docHost || 'page.ru' }); };
  assert(!q('https://ads.one.com/a.js'), 'отключено через $badfilter');
  assert(q('https://keep.com/a.js'));
  assert(q('https://two.net/a.js'));
  assert.strictEqual(e.badfiltered, 1);
});
test('синтаксис AdGuard/uBO не ломает разбор', function () {
  const e = new F.Engine();
  e.addLists(['!#if (adguard)\n||x.com^$removeparam=utm_source\nexample.com#$#.ad { display: none !important; }\nexample.com#%#//scriptlet("abort-on-property-read", "ads")\nexample.com##+js(set-constant, ads, false)\nexample.com##.ad:style(height: 0)\n||y.com^$redirect=noopjs\n||z.com^$3p,xhr\n!#endif']);
  assert(!e.match({ url: 'https://x.com/a', host: 'x.com', type: 'script', docHost: 'p.ru' }));
  assert(e.match({ url: 'https://z.com/a', host: 'z.com', type: 'xmlhttprequest', docHost: 'p.ru' }));
  assert(!e.match({ url: 'https://z.com/a', host: 'z.com', type: 'image', docHost: 'p.ru' }));
  assert.strictEqual(e.userStylesheet({}).indexOf('scriptlet'), -1);
});

test('защита от опасных сайтов блокирует сами страницы', function () {
  const e = new F.Engine({ security: true });
  e.addLists(['! URLhaus\n||malware.example^\n||1.2.3.4/payload.exe\n||phish.example^$document\n||all.example^$all']);
  const q = function (url, type) { return e.match({ url: url, host: new URL(url).hostname, type: type, docHost: '' }); };
  assert(q('https://malware.example/', 'main_frame'));
  assert(q('https://sub.malware.example/x', 'main_frame'));
  assert(q('http://1.2.3.4/payload.exe', 'main_frame'));
  assert(!q('http://1.2.3.4/other', 'main_frame'));
  assert(q('https://phish.example/login', 'main_frame'));
  assert(q('https://all.example/', 'main_frame'));
  assert(q('https://malware.example/a.js', 'script'));
  assert(!q('https://good.example/', 'main_frame'));
  // обычный блокировщик рекламы страницы не трогает
  const ad = new F.Engine();
  ad.addLists(['||malware.example^']);
  assert(!ad.match({ url: 'https://malware.example/', host: 'malware.example', type: 'main_frame', docHost: '' }));
});

// ───────── общая таблица стилей ─────────
function cssConds(css) {
  // вытаскивает условия @-moz-document и превращает regexp("…") обратно в строку regex
  const out = [];
  const re = /@-moz-document (.+?) \{\n([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ cond: m[1], body: m[2] });
  return out;
}
function unCss(s) { return JSON.parse(s.replace(/\\\\/g, '\\\\\\\\').replace(/^"|"$/g, '"')); }
function condMatches(cond, url) {
  return cond.split(/,\s*(?=url-prefix|domain|regexp)/).some(function (c) {
    let m;
    if ((m = /^url-prefix\("(.*)"\)$/.exec(c))) return url.startsWith(m[1]);
    if ((m = /^domain\("(.*)"\)$/.exec(c))) { const h = new URL(url).hostname; return F.hostMatches(h, m[1]); }
    if ((m = /^regexp\((".*")\)$/.exec(c))) {
      const src = m[1].slice(1, -1).replace(/\\\\/g, '\u0000').replace(/\\"/g, '"').replace(/\u0000/g, '\\');
      new RegExp(src, 'v'); // должно компилироваться в строгом режиме
      return new RegExp('^(?:' + src + ')$', 'u').test(url);
    }
    throw new Error('неизвестное условие ' + c);
  });
}
function hiddenOn(css, url, sel) {
  return cssConds(css).some(function (b) {
    return b.body.split('\n').indexOf(sel + '{display:none!important}') >= 0 && condMatches(b.cond, url);
  });
}
test('таблица стилей: общие и частные правила', function () {
  const css = eng.userStylesheet({ allowlist: ['mysite.org'] });
  assert(hiddenOn(css, 'https://plain.com/', '.ad-banner'));
  assert(!hiddenOn(css, 'https://www.nohide.com/x', '.ad-banner'), '~nohide.com');
  assert(!hiddenOn(css, 'https://example.org/', '.ad-banner'), 'example.org#@#');
  assert(hiddenOn(css, 'https://example.org/', 'div[id^="google_ads"]'));
  assert(!hiddenOn(css, 'https://nogeneric.org/', 'div[id^="google_ads"]'), '$generichide');
  assert(!hiddenOn(css, 'https://a.mysite.org/', 'div[id^="google_ads"]'), 'список пользователя');
  assert(hiddenOn(css, 'https://example.org/p', '.sponsored'));
  assert(hiddenOn(css, 'https://www.example.org/p', '.promo'));
  assert(!hiddenOn(css, 'https://sub.example.org/p', '.promo'), '~sub.example.org');
  assert(!hiddenOn(css, 'https://other.org/p', '.sponsored'));
  assert(!hiddenOn(css, 'https://notexample.org/', '.sponsored'));
  assert(css.indexOf('has-text') < 0);
});
test('таблица стилей: свой сайт выключает и частные правила', function () {
  const css = eng.userStylesheet({ allowlist: ['www.example.org'] });
  assert(hiddenOn(css, 'https://example.org/', '.sponsored'));
  assert(!hiddenOn(css, 'https://www.example.org/', '.sponsored'));
});

// ───────── ссылки ─────────
test('VLESS + Reality + Vision', function () {
  const p = L.parseLink('vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=AbCdEf_123&sid=6ba8&type=tcp#%D0%9B%D0%B0%D1%82%D0%B2%D0%B8%D1%8F');
  assert.strictEqual(p.name, 'Латвия');
  assert.strictEqual(p.proto, 'vless');
  const o = p.outbound;
  assert.strictEqual(o.settings.vnext[0].address, '1.2.3.4');
  assert.strictEqual(o.settings.vnext[0].port, 443);
  assert.strictEqual(o.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
  assert.strictEqual(o.streamSettings.security, 'reality');
  assert.strictEqual(o.streamSettings.realitySettings.publicKey, 'AbCdEf_123');
  assert.strictEqual(o.streamSettings.realitySettings.shortId, '6ba8');
  assert.strictEqual(o.streamSettings.network, 'tcp');
});
test('VLESS + WS + TLS', function () {
  const o = L.parseLink('vless://11111111-2222-3333-4444-555555555555@ex.com:8443?type=ws&security=tls&path=%2Fws%3Fed%3D2048&host=cdn.ex.com&sni=cdn.ex.com&alpn=h2,http/1.1').outbound;
  assert.strictEqual(o.streamSettings.wsSettings.path, '/ws?ed=2048');
  assert.strictEqual(o.streamSettings.wsSettings.host, 'cdn.ex.com');
  assert.deepStrictEqual(o.streamSettings.tlsSettings.alpn, ['h2', 'http/1.1']);
});
test('VLESS + XHTTP + extra', function () {
  const o = L.parseLink('vless://11111111-2222-3333-4444-555555555555@[2001:db8::1]:443?type=xhttp&security=reality&pbk=k&sni=a.com&path=%2Fx&mode=packet-up&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#ipv6').outbound;
  assert.strictEqual(o.settings.vnext[0].address, '2001:db8::1');
  assert.strictEqual(o.streamSettings.xhttpSettings.mode, 'packet-up');
  assert.strictEqual(o.streamSettings.xhttpSettings.extra.xPaddingBytes, '100-1000');
});
test('VLESS gRPC', function () {
  const o = L.parseLink('vless://11111111-2222-3333-4444-555555555555@ex.com:443?type=grpc&serviceName=svc&mode=multi&security=tls').outbound;
  assert.strictEqual(o.streamSettings.grpcSettings.serviceName, 'svc');
  assert.strictEqual(o.streamSettings.grpcSettings.multiMode, true);
});
test('VMess (base64 JSON)', function () {
  const j = { v: '2', ps: 'Мой vmess', add: 'vm.ex.com', port: '443', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'vm.ex.com', path: '/v', tls: 'tls', sni: 'vm.ex.com' };
  const link = 'vmess://' + Buffer.from(JSON.stringify(j)).toString('base64');
  const p = L.parseLink(link);
  assert.strictEqual(p.name, 'Мой vmess');
  assert.strictEqual(p.outbound.settings.vnext[0].port, 443);
  assert.strictEqual(p.outbound.streamSettings.wsSettings.path, '/v');
  assert.strictEqual(p.outbound.streamSettings.security, 'tls');
});
test('Trojan', function () {
  const p = L.parseLink('trojan://p%40ss@tr.ex.com:443?sni=tr.ex.com#TR');
  assert.strictEqual(p.outbound.settings.servers[0].password, 'p@ss');
  assert.strictEqual(p.outbound.streamSettings.security, 'tls');
});
test('Shadowsocks SIP002 и старый формат', function () {
  const a = L.parseLink('ss://' + Buffer.from('aes-256-gcm:secret').toString('base64') + '@ss.ex.com:8388#SS');
  assert.strictEqual(a.outbound.settings.servers[0].method, 'aes-256-gcm');
  assert.strictEqual(a.outbound.settings.servers[0].password, 'secret');
  const b = L.parseLink('ss://' + Buffer.from('chacha20-ietf-poly1305:pw@1.1.1.1:443').toString('base64') + '#old');
  assert.strictEqual(b.outbound.settings.servers[0].address, '1.1.1.1');
  assert.strictEqual(b.outbound.settings.servers[0].port, 443);
  const c = L.parseLink('ss://2022-blake3-aes-128-gcm:a2V5MQ%3D%3D@ss.ex.com:443#2022');
  assert.strictEqual(c.outbound.settings.servers[0].password, 'a2V5MQ==');
});
test('SOCKS5 и HTTP прокси', function () {
  const s = L.parseLink('socks5://user:pass@10.0.0.1:1080');
  assert.deepStrictEqual(s.outbound.settings.servers[0].users, [{ user: 'user', pass: 'pass' }]);
  const s2 = L.parseLink('socks://' + Buffer.from('u:p').toString('base64') + '@h.com:1080#b64');
  assert.strictEqual(s2.outbound.settings.servers[0].users[0].pass, 'p');
  const h = L.parseLink('http://proxy.ex.com:3128');
  assert.strictEqual(h.outbound.protocol, 'http');
  assert(!h.outbound.settings.servers[0].users);
  const hs = L.parseLink('https://u:p@proxy.ex.com:443');
  assert.strictEqual(hs.outbound.streamSettings.security, 'tls');
});
test('подписка или прокси', function () {
  assert(L.isSubscriptionURL('https://sub.provider.com/api/sub/abc123'));
  assert(L.isSubscriptionURL('https://sub.provider.com/?token=1'));
  assert(!L.isSubscriptionURL('http://proxy.ex.com:3128'));
  assert(!L.isSubscriptionURL('http://u:p@proxy.ex.com:3128/'));
});
test('разбор подписки base64', function () {
  const body = Buffer.from('vless://11111111-2222-3333-4444-555555555555@a.com:443?security=reality&pbk=k#A\nvmess://xxx\n\ntrojan://p@b.com:443#B\n').toString('base64');
  const links = L.parseSubscription(body);
  assert.strictEqual(links.length, 3);
  assert.throws(function () { L.parseSubscription('{"outbounds":[]}'); });
});
test('ошибки понятны', function () {
  assert.throws(function () { L.parseLink('vless://bad@ex.com:443'); }, /UUID/);
  assert.throws(function () { L.parseLink('vless://11111111-2222-3333-4444-555555555555@ex.com:443?security=reality'); }, /pbk/);
  assert.throws(function () { L.parseLink('hysteria://x@y:1'); }, /не поддерживается/);
  assert.throws(function () { L.parseLink('просто текст'); });
});
test('конфигурация ядра', function () {
  const p = L.parseLink('vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?security=reality&pbk=k&sni=a.com');
  const c = L.buildCoreConfig(p.outbound, { user: 'u', pass: 'p' });
  assert.strictEqual(c.inbounds[0].listen, '127.0.0.1');
  assert.strictEqual(c.inbounds[0].settings.auth, 'password');
  assert.strictEqual(c.outbounds[0].tag, 'proxy');
  assert.strictEqual(c.outbounds[0].protocol, 'vless');
  JSON.stringify(c);
});
test('Hysteria2', function () {
  const p = L.parseLink('hysteria2://p%40ss@hy.ex.com:8443/?sni=hy.ex.com&obfs=salamander&obfs-password=ob&insecure=1#Хай');
  assert.strictEqual(p.core, 'sing-box');
  assert.strictEqual(p.title, 'Hysteria2');
  assert.strictEqual(p.outbound.password, 'p@ss');
  assert.strictEqual(p.outbound.obfs.type, 'salamander');
  assert.strictEqual(p.outbound.tls.insecure, true);
  assert.strictEqual(L.parseLink('hy2://pw@1.2.3.4:443').outbound.server_port, 443);
});
test('TUIC', function () {
  const o = L.parseLink('tuic://11111111-2222-3333-4444-555555555555:secret@t.ex.com:443?congestion_control=bbr&alpn=h3&sni=t.ex.com&udp_relay_mode=native#T').outbound;
  assert.strictEqual(o.uuid, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(o.password, 'secret');
  assert.deepStrictEqual(o.tls.alpn, ['h3']);
});
test('WireGuard', function () {
  const p = L.parseLink('wireguard://cHJpdmF0ZWtleQ%3D%3D@wg.ex.com:51820?publickey=cHVibGlja2V5&address=10.7.0.2,fd00::2&mtu=1420&reserved=1,2,3#WG');
  assert.strictEqual(p.core, 'sing-box');
  assert.strictEqual(p.endpoint.private_key, 'cHJpdmF0ZWtleQ==');
  assert.deepStrictEqual(p.endpoint.address, ['10.7.0.2/32', 'fd00::2/128']);
  assert.deepStrictEqual(p.endpoint.peers[0].reserved, [1, 2, 3]);
  const c = L.buildConfig(p, { user: 'u', pass: 'p' });
  assert.strictEqual(c.core, 'sing-box');
  assert.strictEqual(c.config.endpoints[0].tag, 'proxy');
  assert.strictEqual(c.config.route.default_domain_resolver, 'remote');
  assert.throws(function () { L.parseLink('wireguard://key@h.com:1'); }, /publickey/);
});
test('AnyTLS и SSH', function () {
  assert.strictEqual(L.parseLink('anytls://pw@a.ex.com:443?sni=a.ex.com').outbound.type, 'anytls');
  const s = L.parseLink('ssh://root:toor@10.0.0.5:22#Сервер');
  assert.strictEqual(s.outbound.user, 'root');
  assert.strictEqual(s.outbound.password, 'toor');
});
test('конфигурация второго ядра', function () {
  const p = L.parseLink('hysteria2://pw@h.com:443');
  const c = L.buildConfig(p, { user: 'u', pass: 'p' });
  assert.strictEqual(c.config.inbounds[0].type, 'socks');
  assert.strictEqual(c.config.inbounds[0].users[0].username, 'u');
  assert.strictEqual(c.config.outbounds[0].tag, 'proxy');
  assert.strictEqual(c.config.route.final, 'proxy');
  const x = L.buildConfig(L.parseLink('trojan://pw@t.com:443'), { user: 'u', pass: 'p' });
  assert.strictEqual(x.core, 'xray');
});
test('подписка userinfo'
, function () {
  const i = L.parseUserInfo('upload=1024; download=2048; total=10737418240; expire=1767225600');
  assert.strictEqual(i.total, 10737418240);
  assert.strictEqual(i.expire, 1767225600);
});

console.log((process.exitCode ? 'Есть ошибки. ' : 'Все тесты пройдены. ') + 'Успешно: ' + passed);
