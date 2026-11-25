/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* NetLoom — интерфейс окна браузера. Загружается в каждое окно после запуска. */
(function () {
  "use strict";
  if (window.NetLoomUI) return;

  const { NetLoom } = ChromeUtils.importESModule("chrome://netloom/content/NetLoomService.sys.mjs");
  const { SETTINGS_URL, NEWTAB_URL } = ChromeUtils.importESModule("chrome://netloom/content/boot.sys.mjs");
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const doc = document;

  function html(tag, attrs = {}, children = []) {
    const e = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c) e.append(c);
    return e;
  }

  function svg(paths, { stroke = "currentColor", size = 16, fill = "none", width = 2 } = {}) {
    const s = doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", fill);
    s.setAttribute("stroke", stroke);
    s.setAttribute("stroke-width", width);
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const p = doc.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      s.append(p);
    }
    return s;
  }

  function xul(tag, attrs = {}) {
    const e = doc.createXULElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    return e;
  }

  const system = () => Services.scriptSecurityManager.getSystemPrincipal();

  function openSettings(section) {
    const url = SETTINGS_URL + (section ? "#" + section : "");
    switchToTabHavingURI(url, true, { ignoreFragment: "whenComparingAndReplace", triggeringPrincipal: system() });
  }

  // ───────── Кнопки в панели адреса: VPN и меню ─────────
  const vpnLabel = html("span", { text: "VPN" });
  const vpnBtn = html("button", {
    id: "netloom-vpn", class: "netloom-btn", "aria-label": "VPN",
    onclick: () => vpnPanel.openPopup(vpnBtn, "after_end", 0, 4),
  }, [html("span", { class: "dot", "aria-hidden": "true" }), vpnLabel]);

  const menuBtn = html("button", {
    id: "netloom-menu-button", class: "netloom-btn", title: "Меню", "aria-label": "Меню",
    onclick: () => mainMenu.openPopup(menuBtn, "after_end", 0, 4),
  }, [svg(["M4 7h16", "M4 12h16", "M4 17h16"])]);

  const tools = xul("toolbaritem", { id: "netloom-tools", removable: "false", overflows: "false" });
  tools.append(vpnBtn, menuBtn);
  const urlbarContainer = doc.getElementById("urlbar-container");
  if (urlbarContainer) urlbarContainer.after(tools);
  else doc.getElementById("nav-bar-customization-target")?.append(tools);

  const popupSet = doc.getElementById("mainPopupSet");

  // ───────── Панель VPN ─────────
  const vpnPanel = xul("panel", {
    id: "netloom-vpn-panel", type: "arrow", role: "dialog", noautofocus: "true", "aria-label": "VPN",
  });
  const vpnFrame = html("iframe", { id: "netloom-vpn-frame" });
  vpnPanel.append(vpnFrame);
  vpnPanel.addEventListener("popupshowing", () => {
    if (!vpnFrame.getAttribute("src")) vpnFrame.setAttribute("src", "chrome://netloom/content/vpn.html");
    else vpnFrame.contentWindow?.NetLoomPanel?.refresh();
  });
  popupSet.append(vpnPanel);

  // ───────── Главное меню ─────────
  const mainMenu = xul("menupopup", { id: "netloom-main-menu", class: "netloom-menu" });
  const item = (label, opts = {}) => {
    const mi = xul("menuitem", { label });
    if (opts.command) mi.setAttribute("command", opts.command);
    if (opts.key) mi.setAttribute("key", opts.key);
    if (opts.run) mi.addEventListener("command", opts.run);
    return mi;
  };
  const zoomMenu = xul("menu", { label: "Масштаб" });
  const zoomPopup = xul("menupopup");
  zoomPopup.append(
    item("Увеличить", { command: "cmd_fullZoomEnlarge", key: "key_fullZoomEnlarge" }),
    item("Уменьшить", { command: "cmd_fullZoomReduce", key: "key_fullZoomReduce" }),
    item("Сбросить", { command: "cmd_fullZoomReset", key: "key_fullZoomReset" })
  );
  zoomMenu.append(zoomPopup);
  mainMenu.append(
    item("Новая вкладка", { command: "cmd_newNavigatorTab", key: "key_newNavigatorTab" }),
    item("Новое окно", { command: "cmd_newNavigator", key: "key_newNavigator" }),
    item("Приватное окно", { command: "Tools:PrivateBrowsing", key: "key_privatebrowsing" }),
    xul("menuseparator"),
    item("Закладки", { command: "Browser:ShowAllBookmarks", key: "manBookmarkKb" }),
    item("История", { command: "Browser:ShowAllHistory", key: "showAllHistoryKb" }),
    item("Загрузки", { command: "Tools:Downloads", key: "key_openDownloads" }),
    item("Пароли", { run: () => LoginHelper.openPasswordManager(window, { entryPoint: "mainmenu" }) }),
    xul("menuseparator"),
    zoomMenu,
    item("Найти на странице", { command: "cmd_find", key: "key_find" }),
    item("Печать", { command: "cmd_print", key: "printKb" }),
    xul("menuseparator"),
    item("Настройки", { run: () => openSettings() }),
    item("Выход", { command: "cmd_quitApplication", key: "key_quitApplication" })
  );
  popupSet.append(mainMenu);

  // настройки движка всегда открывают настройки NetLoom
  window.openPreferences = function () { openSettings(); };

  // ───────── Обновление состояния ─────────
  const STATUS_TEXT = { off: "VPN", connecting: "Подключение…", error: "VPN: ошибка" };

  function updateVpn() {
    const s = NetLoom.settings;
    let status = s?.vpn ? NetLoom.vpn.status : "off";
    if (s?.vpn && status === "off") status = "connecting";
    vpnBtn.setAttribute("status", status);
    let text = STATUS_TEXT[status] || "VPN";
    if (status === "connected") text = "VPN · " + (NetLoom.activeServer()?.name || "");
    vpnLabel.textContent = text.length > 28 ? text.slice(0, 27) + "…" : text;
    vpnBtn.setAttribute("title", status === "error" ? NetLoom.vpn.error : "VPN");
  }

  const observer = {
    observe(subject, topic) {
      if (topic === "netloom-state") updateVpn();
    },
    QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  };
  Services.obs.addObserver(observer, "netloom-state");

  window.addEventListener("unload", () => {
    Services.obs.removeObserver(observer, "netloom-state");
  }, { once: true });

  // своя новая вкладка не показывает адрес в строке
  if (Array.isArray(window.gInitialPages) && !window.gInitialPages.includes(NEWTAB_URL)) window.gInitialPages.push(NEWTAB_URL);

  NetLoom.init().then(updateVpn);

  // мастер-пароль обязателен: предложить создать, если его ещё нет
  setTimeout(() => {
    try {
      if (window !== Services.wm.getMostRecentWindow("navigator:browser")) return;
      if (!Services.prefs.getBoolPref("netloom.primaryPassword.prompt", true)) return;
      if (!LoginHelper.isPrimaryPasswordSet() && !NetLoom._askedPrimaryPassword) {
        NetLoom._askedPrimaryPassword = true;
        window.openDialog("chrome://mozapps/content/preferences/changemp.xhtml", "", "centerscreen,chrome,modal,titlebar");
      }
    } catch (e) {
      Services.console.logStringMessage("NetLoom: мастер-пароль: " + e);
    }
  }, 1500);

  window.NetLoomUI = { openSettings, updateVpn };
})();
