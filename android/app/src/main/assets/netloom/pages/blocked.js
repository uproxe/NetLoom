'use strict';
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const kind = params.get('kind') || 'malware';
let host = '';
try { host = new URL(url).hostname; } catch (e) { /* неверный адрес */ }

const REASONS = {
  malware: ['Сайт распространяет вирусы', 'Этот адрес есть в списке сайтов, через которые распространяются вредоносные программы. Если открыть его, на телефон может попасть вирус.'],
  phishing: ['Поддельный сайт', 'Этот адрес есть в списке фишинговых сайтов: он притворяется известным сервисом, чтобы украсть пароли или данные карт.']
};
const r = REASONS[kind] || REASONS.malware;
document.getElementById('title').textContent = r[0];
document.getElementById('reason').textContent = r[1] + ' Проверка выполнена на вашем телефоне.';
document.getElementById('host').textContent = host || url;

document.getElementById('back').addEventListener('click', function () {
  if (history.length > 1) history.back(); else location.replace('about:blank');
});
document.getElementById('proceed').addEventListener('click', async function () {
  if (!/^https?:/i.test(url)) return;
  await browser.runtime.sendMessage({ type: 'bypassDanger', url: url });
  location.replace(url);
});
