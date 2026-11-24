/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
const { NetLoom } = ChromeUtils.importESModule("chrome://netloom/content/NetLoomService.sys.mjs");
const params = new URLSearchParams(location.search);
const url = params.get("url") || "";
const kind = params.get("kind") || "malware";
let host = "";
try { host = new URL(url).hostname; } catch (e) {}

const REASONS = {
  malware: ["Сайт распространяет вирусы", "Этот адрес есть в списке сайтов, через которые распространяются вредоносные программы. Если открыть его, на компьютер может попасть вирус."],
  phishing: ["Поддельный сайт", "Этот адрес есть в списке фишинговых сайтов: он притворяется известным сервисом, чтобы украсть пароли или данные карт."],
  pup: ["Нежелательные программы", "С этого адреса раздают программы, которые без спроса меняют настройки, показывают рекламу или собирают данные."],
};
const [title, reason] = REASONS[kind] || REASONS.malware;
document.getElementById("title").textContent = title;
document.getElementById("reason").textContent = reason + " Проверка выполнена на вашем компьютере.";
document.getElementById("host").textContent = host || url;

document.getElementById("back").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.replace("about:start");
});
document.getElementById("proceed").addEventListener("click", () => {
  if (!/^https?:/i.test(url)) return;
  NetLoom.bypassDanger(host);
  location.replace(url);
});
