/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
const { NetLoom } = ChromeUtils.importESModule("chrome://netloom/content/NetLoomService.sys.mjs");
const $ = id => document.getElementById(id);
const bw = window.top;

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  children.forEach(c => c && e.append(c));
  return e;
}

function currentHost() {
  try {
    const u = bw.gBrowser.selectedBrowser.currentURI;
    return /^https?$/.test(u.scheme) ? u.host.replace(/^www\./, "") : "";
  } catch (e) { return ""; }
}

function fmtBytes(n) {
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
}

function pingText(ms) {
  return ms === undefined ? "" : ms < 0 ? "нет ответа" : ms + " мс";
}

const STATUS = { off: "Отключено", connecting: "Подключение…", connected: "Подключено", error: "Ошибка" };

function render() {
  const s = NetLoom.settings;
  if (!s) return;
  let st = s.vpn ? NetLoom.vpn.status : "off";
  if (s.vpn && st === "off") st = "connecting";
  $("vpn").checked = s.vpn;
  $("dot").className = "dot " + st;
  let text = STATUS[st];
  const active = NetLoom.activeServer();
  if (st === "connected" && active) {
    text += " · " + active.name;
    const p = NetLoom.pings[active.id];
    if (p >= 0) text += " · " + p + " мс";
  }
  if (st === "error") text = NetLoom.vpn.error;
  $("status").textContent = text;
  $("status").parentElement.classList.toggle("error", st === "error");

  // серверы, сгруппированные по подпискам
  const box = $("servers");
  box.textContent = "";
  if (!s.servers.length) {
    box.append(el("div", { class: "empty", text: "Серверов пока нет. Добавьте ссылку или подписку." }));
  }
  const groups = [{ id: null, title: "Мои серверы" }].concat(s.subs.map(x => ({ id: x.id, title: x.name, sub: x })));
  for (const g of groups) {
    const list = s.servers.filter(x => (x.sub || null) === g.id);
    if (!list.length) continue;
    let meta = "";
    if (g.sub?.info) {
      const used = g.sub.info.upload + g.sub.info.download;
      if (g.sub.info.total) meta = fmtBytes(used) + " из " + fmtBytes(g.sub.info.total);
      if (g.sub.info.expire) meta += (meta ? " · " : "") + "до " + new Date(g.sub.info.expire * 1000).toLocaleDateString("ru-RU");
    }
    box.append(el("div", { class: "group" }, [el("span", { class: "label-caps", text: g.title }), el("span", { class: "muted", text: meta })]));
    for (const srv of list) {
      const ping = NetLoom.pings[srv.id];
      const radio = el("input", { type: "radio", name: "srv", "aria-label": srv.name });
      radio.checked = srv.id === s.activeServerId;
      radio.addEventListener("change", () => NetLoom.selectServer(srv.id));
      box.append(el("label", { class: "srv" + (radio.checked ? " active" : ""), title: srv.address + ":" + srv.port }, [
        radio,
        el("span", { class: "name", text: srv.name }),
        el("span", { class: "tag", text: srv.proto }),
        el("span", { class: "ping" + (ping >= 0 && ping < 150 ? " good" : ""), text: pingText(ping) }),
      ]));
    }
  }

  $("ruDirect").checked = s.ruDirect;
  const host = currentHost();
  $("siteBox").hidden = !host;
  $("siteLabel").textContent = "Этот сайт · " + host;
  const mode = host ? NetLoom.ruleFor(host) : "auto";
  for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  fitFrame();
}

function fitFrame() {
  if (window.frameElement) window.frameElement.style.height = Math.min(620, Math.ceil(document.body.getBoundingClientRect().height)) + "px";
}

$("vpn").addEventListener("change", e => NetLoom.setVpn(e.target.checked));
$("ruDirect").addEventListener("change", e => NetLoom.setRuDirect(e.target.checked));
for (const b of document.querySelectorAll(".seg button")) {
  b.addEventListener("click", () => {
    const host = currentHost();
    if (host) NetLoom.setRule(host, b.dataset.mode);
  });
}
$("addToggle").addEventListener("click", () => {
  $("addBox").hidden = !$("addBox").hidden;
  if (!$("addBox").hidden) $("addText").focus();
  fitFrame();
});
$("addBtn").addEventListener("click", async () => {
  const text = $("addText").value.trim();
  if (!text) return;
  $("addBtn").disabled = true;
  $("addResult").textContent = "Добавляю…";
  try {
    const r = await NetLoom.addInput(text);
    const parts = [];
    if (r.added) parts.push("Добавлено: " + r.added);
    if (r.errors.length) parts.push(r.errors.join("; "));
    $("addResult").textContent = parts.join(". ");
    if (r.added && !r.errors.length) { $("addText").value = ""; $("addBox").hidden = true; }
  } finally {
    $("addBtn").disabled = false;
    fitFrame();
  }
});
$("pingBtn").addEventListener("click", async () => {
  $("pingBtn").disabled = true;
  $("pingBtn").textContent = "…";
  try { await NetLoom.pingAll(); } finally { $("pingBtn").disabled = false; $("pingBtn").textContent = "Пинг"; }
});
$("rulesLink").addEventListener("click", e => {
  e.preventDefault();
  bw.NetLoomUI?.openSettings("vpn");
  bw.document.getElementById("netloom-vpn-panel")?.hidePopup();
});

const observer = { observe: render, QueryInterface: ChromeUtils.generateQI(["nsIObserver"]) };
Services.obs.addObserver(observer, "netloom-state");
window.addEventListener("unload", () => Services.obs.removeObserver(observer, "netloom-state"));
window.NetLoomPanel = { refresh: render };
NetLoom.init().then(render);
