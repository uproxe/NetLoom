/* NetLoom для Android — страница настроек */
'use strict';
const $ = function (id) { return document.getElementById(id); };
function send(type, extra) {
  return browser.runtime.sendMessage(Object.assign({ type: type }, extra || {})).then(function (r) {
    if (r && r.error) throw new Error(r.error);
    return r;
  });
}
function el(tag, props, children) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    if (k === 'text') e.textContent = props[k];
    else if (k === 'cls') e.className = props[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
    else e.setAttribute(k, props[k]);
  }
  (children || []).forEach(function (c) { if (c) e.append(c); });
  return e;
}
function fmtBytes(n) {
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

let S = null;
const STATUS = {
  off: ['Выключен', ''], connecting: ['Подключение…', 'wait'], connected: ['Подключён', 'on'], error: ['Ошибка', 'err']
};

async function render() {
  S = await send('getState');
  $('vpnOn').checked = S.vpn;
  const st = S.vpn ? (STATUS[S.vpnStatus] || STATUS.off) : STATUS.off;
  $('vpnDot').className = 'dot ' + st[1];
  let text = st[0];
  if (S.vpn && S.vpnStatus === 'connected' && S.activeServerName) text += ' — ' + S.activeServerName;
  if (S.vpn && S.vpnStatus === 'error' && S.vpnError) text = S.vpnError;
  $('vpnStatus').textContent = text;

  // серверы
  const box = $('servers');
  box.textContent = '';
  if (!S.servers.length) {
    box.append(el('div', { cls: 'row' }, [el('div', { cls: 'grow muted small', text: 'Серверов пока нет. Добавьте ссылку на сервер или подписку ниже.' })]));
  }
  for (const s of S.servers) {
    const ping = S.pings[s.id];
    const pingEl = ping === undefined ? null :
      el('span', { cls: 'ping ' + (ping < 0 ? 'bad' : ping < 300 ? 'good' : ''), text: ping < 0 ? 'нет связи' : ping + ' мс' });
    const radio = el('input', { type: 'radio', name: 'srv' });
    radio.checked = s.id === S.activeServerId;
    radio.addEventListener('change', function () { send('selectServer', { id: s.id }).then(render); });
    const sub = s.sub ? S.subs.find(function (x) { return x.id === s.sub; }) : null;
    const row = el('label', { cls: 'row' }, [
      radio,
      el('div', { cls: 'grow' }, [
        el('div', {}, [document.createTextNode(s.name), el('span', { cls: 'tag', text: s.proto })]),
        el('div', { cls: 'sub', text: (s.address || '') + (sub ? ' · ' + sub.name : '') })
      ]),
      pingEl,
      s.sub ? null : el('button', { cls: 'link', text: '✕', 'aria-label': 'Удалить', onclick: function (e) {
        e.preventDefault();
        if (confirm('Удалить сервер «' + s.name + '»?')) send('removeServer', { id: s.id }).then(render);
      } })
    ]);
    box.append(row);
  }

  // подписки
  $('subsBlock').classList.toggle('hidden', !S.subs.length);
  const subs = $('subs');
  subs.textContent = '';
  for (const sub of S.subs) {
    let info = '';
    if (sub.info) {
      const used = (sub.info.upload || 0) + (sub.info.download || 0);
      if (sub.info.total) info = 'Израсходовано ' + fmtBytes(used) + ' из ' + fmtBytes(sub.info.total);
      if (sub.info.expire) info += (info ? ' · ' : '') + 'до ' + new Date(sub.info.expire * 1000).toLocaleDateString('ru-RU');
    }
    if (sub.error) info = 'Ошибка: ' + sub.error;
    const n = S.servers.filter(function (s) { return s.sub === sub.id; }).length;
    subs.append(el('div', { cls: 'row' }, [
      el('div', { cls: 'grow' }, [
        el('div', { text: sub.name + ' · ' + n + ' ' + plural(n, 'сервер', 'сервера', 'серверов') }),
        el('div', { cls: 'sub', text: info || sub.url })
      ]),
      el('button', { text: 'Обновить', onclick: function () {
        this.disabled = true;
        send('updateSub', { id: sub.id }).then(render);
      } }),
      el('button', { cls: 'link', text: '✕', onclick: function () {
        if (confirm('Удалить подписку и её серверы?')) send('removeSub', { id: sub.id }).then(render);
      } })
    ]));
  }

  // правила сайтов
  $('ruDirect').checked = S.ruDirect;
  const rules = $('rules');
  rules.textContent = '';
  for (const r of S.rules) {
    const seg = el('div', { cls: 'seg' }, [
      el('button', { cls: r.mode === 'vpn' ? 'on' : '', text: 'VPN', onclick: function () { send('setRule', { host: r.host, mode: 'vpn' }).then(render); } }),
      el('button', { cls: r.mode === 'direct' ? 'on' : '', text: 'Напрямую', onclick: function () { send('setRule', { host: r.host, mode: 'direct' }).then(render); } }),
      el('button', { text: '✕', onclick: function () { send('setRule', { host: r.host, mode: 'auto' }).then(render); } })
    ]);
    rules.append(el('div', { cls: 'row' }, [el('div', { cls: 'grow', text: r.host }), seg]));
  }

  // реклама и безопасность
  $('adblock').checked = S.adblock;
  if (S.filters) {
    $('filterStats').textContent = 'Базы AdGuard и EasyList: ' + S.filters.network.toLocaleString('ru-RU') + ' правил' +
      (S.blockedTotal ? ' · заблокировано за сеанс: ' + S.blockedTotal.toLocaleString('ru-RU') : '');
  }
  if (document.activeElement !== $('allowlist')) $('allowlist').value = S.allowlist.join('\n');
  $('security').checked = S.security;
  if (S.securityRules) $('secStats').textContent = 'Вирусы, фишинг и нежелательные программы: ' + S.securityRules.toLocaleString('ru-RU') + ' адресов. Проверка идёт на телефоне, без Google.';

  // настройки приложения
  const app = S.app || {};
  $('rfp').checked = !!app.rfp;
  $('clearOnExit').checked = !!app.clearOnExit;
  if (app.search) $('search').value = app.search;
  $('ver').textContent = app.version || '';
  $('engine').textContent = app.engine ? 'Движок ' + app.engine : '';
}

$('vpnOn').addEventListener('change', function () { send('setVpn', { on: this.checked }).then(render); });
$('ping').addEventListener('click', async function () {
  this.disabled = true; this.textContent = 'Проверяю…';
  try { await send('pingAll'); } finally { this.disabled = false; this.textContent = 'Проверить скорость'; render(); }
});
$('add').addEventListener('click', async function () {
  const text = $('addText').value.trim();
  if (!text) return;
  this.disabled = true;
  $('addMsg').className = 'msg'; $('addMsg').textContent = 'Добавляю…';
  try {
    const r = await send('addInput', { text: text });
    let msg = r.added ? 'Добавлено: ' + r.added : '';
    if (r.errors.length) msg += (msg ? '. ' : '') + r.errors.join('; ');
    $('addMsg').className = 'msg' + (r.errors.length && !r.added ? ' err' : '');
    $('addMsg').textContent = msg;
    if (r.added) $('addText').value = '';
  } catch (e) {
    $('addMsg').className = 'msg err'; $('addMsg').textContent = e.message;
  }
  this.disabled = false;
  render();
});
$('paste').addEventListener('click', async function () {
  try { $('addText').value = await navigator.clipboard.readText(); } catch (e) {
    $('addMsg').className = 'msg'; $('addMsg').textContent = 'Нажмите в поле и выберите «Вставить».';
  }
});
$('ruDirect').addEventListener('change', function () { send('setRuDirect', { on: this.checked }); });
function addRule(mode) {
  send('setRule', { host: $('ruleHost').value, mode: mode }).then(function () {
    $('ruleHost').value = ''; $('ruleMsg').textContent = ''; render();
  }, function (e) { $('ruleMsg').className = 'msg err'; $('ruleMsg').textContent = e.message; });
}
$('ruleVpn').addEventListener('click', function () { addRule('vpn'); });
$('ruleDirect').addEventListener('click', function () { addRule('direct'); });
$('adblock').addEventListener('change', function () { send('setAdblock', { on: this.checked }).then(render); });
$('saveAllow').addEventListener('click', function () {
  send('setAllowlist', { text: $('allowlist').value }).then(function () { $('listMsg').textContent = 'Сохранено'; render(); });
});
$('updateLists').addEventListener('click', async function () {
  this.disabled = true; $('listMsg').textContent = 'Обновляю базы…';
  try {
    const changed = await send('updateLists');
    $('listMsg').textContent = changed ? 'Базы обновлены' : 'Базы уже свежие';
  } catch (e) { $('listMsg').textContent = e.message; }
  this.disabled = false;
  render();
});
$('security').addEventListener('change', function () { send('setSecurity', { on: this.checked }); });
$('rfp').addEventListener('change', function () { send('appSet', { key: 'rfp', value: this.checked }); });
$('clearOnExit').addEventListener('change', function () { send('appSet', { key: 'clearOnExit', value: this.checked }); });
$('search').addEventListener('change', function () { send('appSet', { key: 'search', value: this.value }); });
$('clearNow').addEventListener('click', function () {
  if (confirm('Удалить куки, историю и кэш? Придётся заново входить на сайты.')) send('appAction', { name: 'clearData' });
});
$('makeDefault').addEventListener('click', function () { send('appAction', { name: 'defaultBrowser' }); });

browser.runtime.onMessage.addListener(function (m) { if (m && m.type === 'stateChanged') render(); });
render().then(function () {
  if (location.hash) { const t = document.querySelector(location.hash); if (t) t.scrollIntoView(); }
});
