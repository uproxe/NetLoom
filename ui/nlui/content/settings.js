/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { NetLoom } = ChromeUtils.importESModule("chrome://netloom/content/NetLoomService.sys.mjs");
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BookmarkHTMLUtils: "resource://gre/modules/BookmarkHTMLUtils.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "ShellService", () => {
  try {
    return ChromeUtils.importESModule("moz-src:///browser/components/shell/ShellService.sys.mjs").ShellService;
  } catch (e) {
    return ChromeUtils.importESModule("resource:///modules/ShellService.sys.mjs").ShellService;
  }
});
/** Служба поиска движка (в новых версиях — отдельный модуль) */
function searchService() {
  try {
    return ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs").SearchService;
  } catch (e) {
    return typeof Services !== "undefined" ? Services.search : null;
  }
}


const $ = id => document.getElementById(id);
const topWin = () => window.browsingContext.topChromeWindow;

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

const prefs = {
  bool(name, def = false) { return Services.prefs.getBoolPref(name, def); },
  setBool(name, v) { Services.prefs.setBoolPref(name, v); },
  int(name, def = 0) { return Services.prefs.getIntPref(name, def); },
};

function fmtBytes(n) {
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
}

// ═════════ Основное ═════════
async function renderGeneral() {
  try {
    const isDefault = lazy.ShellService.isDefaultBrowser(false, false);
    $("makeDefault").hidden = isDefault;
    $("defaultHint").textContent = isDefault ? "NetLoom — браузер по умолчанию" : "Ссылки из других программ будут открываться здесь";
  } catch (e) {
    $("defaultHint").textContent = "Недоступно в этой версии";
    $("makeDefault").disabled = true;
  }

  const search = searchService();
  const engines = await search.getVisibleEngines();
  const current = await search.getDefault();
  const sel = $("engine");
  sel.textContent = "";
  for (const e of engines) {
    const o = el("option", { value: e.name, text: e.name });
    o.selected = e.name === current?.name;
    sel.append(o);
  }
  $("startup").value = String(prefs.int("browser.startup.page", 3) === 3 ? 3 : 1);
}

$("makeDefault").addEventListener("click", async () => {
  try {
    await lazy.ShellService.setDefaultBrowser(false);
    setTimeout(renderGeneral, 1500);
  } catch (e) {
    $("defaultHint").textContent = "Не получилось. Откройте «Параметры Windows → Приложения по умолчанию» и выберите NetLoom.";
  }
});
$("engine").addEventListener("change", async e => {
  const search = searchService();
  const engine = search.getEngineByName(e.target.value);
  const reason = search.CHANGE_REASON?.USER ?? Ci.nsISearchService?.CHANGE_REASON_USER;
  if (engine) await search.setDefault(engine, reason);
});
$("startup").addEventListener("change", e => Services.prefs.setIntPref("browser.startup.page", +e.target.value));

// ═════════ Приватность ═════════
const CLEAR_ON = {
  "privacy.sanitize.sanitizeOnShutdown": true,
  "privacy.clearOnShutdown_v2.cookiesAndStorage": true,
  "privacy.clearOnShutdown.cookies": true,
  "privacy.clearOnShutdown.offlineApps": true,
  "privacy.clearOnShutdown.sessions": true,
  // историю и загрузки не трогаем
  "privacy.clearOnShutdown_v2.historyFormDataAndDownloads": false,
  "privacy.clearOnShutdown_v2.browsingHistoryAndDownloads": false,
  "privacy.clearOnShutdown_v2.formdata": false,
  "privacy.clearOnShutdown_v2.siteSettings": false,
  "privacy.clearOnShutdown.history": false,
  "privacy.clearOnShutdown.downloads": false,
  "privacy.clearOnShutdown.formdata": false,
  "privacy.clearOnShutdown.siteSettings": false,
};
const SAFE_BROWSING = ["browser.safebrowsing.malware.enabled", "browser.safebrowsing.phishing.enabled", "browser.safebrowsing.downloads.enabled"];

function primaryPasswordSet() {
  try {
    return Cc["@mozilla.org/security/pk11tokendb;1"].getService(Ci.nsIPK11TokenDB).getInternalKeyToken().hasPassword;
  } catch (e) {
    return false;
  }
}

function renderPrivacy() {
  const pp = primaryPasswordSet();
  $("ppStatus").textContent = pp ? "Включён" : "Не задан";
  $("ppStatus").className = "status-text " + (pp ? "on" : "off");
  $("ppChange").textContent = pp ? "Изменить" : "Задать";
  $("adblock").checked = !!NetLoom.settings?.adblock;
  $("clearCookies").checked = prefs.bool("privacy.sanitize.sanitizeOnShutdown") && prefs.bool("privacy.clearOnShutdown_v2.cookiesAndStorage", prefs.bool("privacy.clearOnShutdown.cookies"));
  $("rfp").checked = prefs.bool("privacy.resistFingerprinting");
  $("safebrowsing").checked = prefs.bool(SAFE_BROWSING[0], true) && prefs.bool(SAFE_BROWSING[1], true);
}

$("ppChange").addEventListener("click", () => {
  topWin().openDialog("chrome://mozapps/content/preferences/changemp.xhtml", "", "centerscreen,chrome,modal,titlebar");
  renderPrivacy();
});
$("adblock").addEventListener("change", e => NetLoom.setAdblock(e.target.checked));
$("clearCookies").addEventListener("change", e => {
  if (e.target.checked) for (const [k, v] of Object.entries(CLEAR_ON)) prefs.setBool(k, v);
  else prefs.setBool("privacy.sanitize.sanitizeOnShutdown", false);
});
$("rfp").addEventListener("change", e => prefs.setBool("privacy.resistFingerprinting", e.target.checked));
$("safebrowsing").addEventListener("change", e => SAFE_BROWSING.forEach(p => prefs.setBool(p, e.target.checked)));

// ═════════ VPN и прокси ═════════
function renderVpn() {
  const s = NetLoom.settings;
  if (!s) return;

  const sl = $("serverList");
  sl.textContent = "";
  if (!s.servers.length) sl.append(el("div", { class: "empty", text: "Серверов пока нет" }));
  for (const srv of s.servers) {
    const sub = srv.sub ? s.subs.find(x => x.id === srv.sub) : null;
    const ping = NetLoom.pings[srv.id];
    sl.append(el("div", { class: "item" + (srv.id === s.activeServerId ? " active" : "") }, [
      el("span", { class: "tag", text: srv.proto }),
      el("span", { class: "name", text: srv.name, title: srv.address + ":" + srv.port }),
      el("span", { class: "muted", text: [ping === undefined ? "" : ping < 0 ? "нет ответа" : ping + " мс", sub ? sub.name : ""].filter(Boolean).join(" · ") }),
      srv.id === s.activeServerId ? null : el("button", { class: "btn", text: "Выбрать", onclick: () => NetLoom.selectServer(srv.id) }),
      srv.sub ? null : el("button", { class: "icon-x", text: "×", "aria-label": "Удалить сервер " + srv.name, onclick: () => NetLoom.removeServer(srv.id) }),
    ]));
  }

  const ul = $("subList");
  ul.textContent = "";
  if (!s.subs.length) ul.append(el("div", { class: "empty", text: "Подписок пока нет" }));
  for (const sub of s.subs) {
    const meta = [s.servers.filter(x => x.sub === sub.id).length + " серв."];
    if (sub.info?.total) meta.push(fmtBytes(sub.info.upload + sub.info.download) + " из " + fmtBytes(sub.info.total));
    if (sub.info?.expire) meta.push("до " + new Date(sub.info.expire * 1000).toLocaleDateString("ru-RU"));
    if (sub.error) meta.push("ошибка: " + sub.error);
    ul.append(el("div", { class: "item" }, [
      el("span", { class: "name", text: sub.name, title: sub.url }),
      el("span", { class: sub.error ? "err" : "muted", text: meta.join(" · ") }),
      el("button", { class: "btn", text: "Обновить", onclick: ev => { ev.target.disabled = true; NetLoom.refreshSub(sub); } }),
      el("button", { class: "icon-x", text: "×", "aria-label": "Удалить подписку " + sub.name, onclick: () => NetLoom.removeSub(sub.id) }),
    ]));
  }

  $("ruDirect").checked = s.ruDirect;

  const rl = $("ruleList");
  rl.textContent = "";
  for (const r of s.rules) {
    rl.append(el("div", { class: "item" }, [
      el("span", { class: "name", text: r.host }),
      el("span", { class: "mode " + r.mode, text: r.mode === "vpn" ? "Через VPN" : "Напрямую" }),
      el("button", { class: "icon-x", text: "×", "aria-label": "Удалить правило " + r.host, onclick: () => NetLoom.setRule(r.host, "auto") }),
    ]));
  }
}

$("addBtn").addEventListener("click", async () => {
  const text = $("addText").value.trim();
  if (!text) return;
  $("addBtn").disabled = true;
  $("addResult").textContent = "Добавляю…";
  try {
    const r = await NetLoom.addInput(text);
    $("addResult").textContent = [r.added ? "Добавлено: " + r.added : "", r.errors.join("; ")].filter(Boolean).join(". ");
    if (r.added && !r.errors.length) $("addText").value = "";
  } finally {
    $("addBtn").disabled = false;
  }
});
$("pingBtn").addEventListener("click", async () => {
  $("pingBtn").disabled = true;
  try { await NetLoom.pingAll(); } finally { $("pingBtn").disabled = false; }
});
$("ruDirect").addEventListener("change", e => NetLoom.setRuDirect(e.target.checked));
$("ruleAdd").addEventListener("click", () => {
  $("ruleErr").textContent = "";
  try {
    NetLoom.setRule($("ruleHost").value, $("ruleMode").value);
    $("ruleHost").value = "";
  } catch (e) {
    $("ruleErr").textContent = e.message;
  }
});
$("ruleHost").addEventListener("keydown", e => { if (e.key === "Enter") $("ruleAdd").click(); });

// ═════════ Импорт и экспорт ═════════
function showWizard() {
  lazy.MigrationUtils.showMigrationWizard(topWin(), {
    entrypoint: lazy.MigrationUtils.MIGRATION_ENTRYPOINTS?.PREFERENCES,
  });
}
document.querySelectorAll("[data-wizard]").forEach(b => b.addEventListener("click", showWizard));

/** Закладки Яндекс Браузера (Chromium-формат) */
async function importYandex() {
  const local = Services.dirsvc.get("LocalAppData", Ci.nsIFile).path;
  const userData = PathUtils.join(local, "Yandex", "YandexBrowser", "User Data");
  let file = null;
  for (const name of ["Default", "Profile 1", "Profile 2"]) {
    const p = PathUtils.join(userData, name, "Bookmarks");
    if (await IOUtils.exists(p)) { file = p; break; }
  }
  if (!file) throw new Error("Яндекс Браузер не найден на этом компьютере");
  const data = await IOUtils.readJSON(file);
  const { PlacesUtils } = lazy;
  let count = 0;
  const convert = node => {
    if (node.type === "url") {
      if (!/^(https?|ftp|file):/i.test(node.url || "")) return null;
      count++;
      return { url: node.url, title: node.name || node.url };
    }
    if (node.type === "folder") {
      return { type: PlacesUtils.bookmarks.TYPE_FOLDER, title: node.name || "Папка", children: (node.children || []).map(convert).filter(Boolean) };
    }
    return null;
  };
  const roots = data.roots || {};
  const children = [];
  for (const [key, title] of [["bookmark_bar", "Панель закладок"], ["other", "Другие закладки"], ["synced", "Мобильные"]]) {
    if (roots[key]?.children?.length) {
      children.push({ type: PlacesUtils.bookmarks.TYPE_FOLDER, title, children: roots[key].children.map(convert).filter(Boolean) });
    }
  }
  if (!count) throw new Error("В Яндекс Браузере нет закладок");
  await PlacesUtils.bookmarks.insertTree({
    guid: PlacesUtils.bookmarks.menuGuid,
    children: [{ type: PlacesUtils.bookmarks.TYPE_FOLDER, title: "Из Яндекс Браузера", children }],
  });
  return count;
}

$("impYandex").addEventListener("click", async () => {
  $("impResult").textContent = "Переношу закладки…";
  try {
    const n = await importYandex();
    $("impResult").textContent = "Перенесено закладок: " + n + " (папка «Из Яндекс Браузера» в меню закладок). Пароли из Яндекс Браузера пока переносятся через файл CSV.";
  } catch (e) {
    $("impResult").textContent = e.message;
  }
});

$("expBookmarks").addEventListener("click", async () => {
  const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  fp.init(window.browsingContext, "Экспорт закладок", Ci.nsIFilePicker.modeSave);
  fp.appendFilters(Ci.nsIFilePicker.filterHTML);
  fp.defaultString = "закладки-netloom.html";
  const res = await new Promise(r => fp.open(r));
  if (res === Ci.nsIFilePicker.returnOK || res === Ci.nsIFilePicker.returnReplace) {
    await lazy.BookmarkHTMLUtils.exportToFile(fp.file.path);
    $("impResult").textContent = "Закладки сохранены: " + fp.file.path;
  }
});
$("expPasswords").addEventListener("click", () => {
  lazy.LoginHelper.openPasswordManager(topWin(), { entryPoint: "preferences" });
  $("impResult").textContent = "В открывшемся окне паролей: меню «⋯» → «Экспорт паролей».";
});

// ═════════ Фильтры ═════════
function renderFilters() {
  const st = NetLoom.engineStats;
  if (st) {
    $("filterStats").textContent = "Сетевых правил: " + st.network.toLocaleString("ru-RU") +
      " · скрытие элементов: " + (st.cosmeticGeneric + st.cosmeticSpecific).toLocaleString("ru-RU");
  }
  const al = $("allowList");
  al.textContent = "";
  const allow = NetLoom.settings?.allowlist || [];
  for (const host of allow) {
    al.append(el("div", { class: "item" }, [
      el("span", { class: "name", text: host }),
      el("button", { class: "icon-x", text: "×", "aria-label": "Снова блокировать на " + host, onclick: () => NetLoom.setSiteAllowed(host, false) }),
    ]));
  }
}
$("allowAdd").addEventListener("click", async () => {
  const host = $("allowHost").value.trim();
  if (!host) return;
  await NetLoom.setSiteAllowed(host, true);
  $("allowHost").value = "";
});
$("allowHost").addEventListener("keydown", e => { if (e.key === "Enter") $("allowAdd").click(); });
$("listsUpdate").addEventListener("click", async e => {
  e.target.disabled = true;
  e.target.textContent = "Загружаю…";
  try {
    const changed = await NetLoom.updateLists(true);
    e.target.textContent = changed ? "Обновлено" : "Не удалось скачать";
  } finally {
    setTimeout(() => { e.target.disabled = false; e.target.textContent = "Обновить списки"; }, 2000);
  }
});

$("version").textContent = "· движок " + Services.appinfo.version;
$("repoLink").addEventListener("click", e => {
  e.preventDefault();
  topWin().openTrustedLinkIn(e.target.href, "tab");
});

// ═════════ Обновление ═════════
function renderAll() {
  renderPrivacy();
  renderVpn();
  renderFilters();
}
const observer = { observe: renderAll, QueryInterface: ChromeUtils.generateQI(["nsIObserver"]) };
Services.obs.addObserver(observer, "netloom-state");
window.addEventListener("unload", () => Services.obs.removeObserver(observer, "netloom-state"));
window.addEventListener("focus", renderPrivacy);

NetLoom.init().then(() => {
  renderGeneral().catch(e => console.error(e));
  renderAll();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
});
