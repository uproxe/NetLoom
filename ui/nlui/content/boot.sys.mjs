/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// NetLoom: запуск службы и подключение интерфейса к каждому окну браузера.
import { NetLoom } from "chrome://netloom/content/NetLoomService.sys.mjs";

const BROWSER_URL = "chrome://browser/content/browser.xhtml";
// адреса, которые видит пользователь
export const NEWTAB_URL = "about:start";
export const SETTINGS_URL = "about:settings";
// где лежат страницы
const PAGES = {
  settings: "chrome://netloom/content/settings.html",
  preferences: "chrome://netloom/content/settings.html",
  start: "chrome://netloom/content/newtab.html",
  privatebrowsing: "chrome://netloom/content/private.html",
  blocked: "chrome://netloom/content/blocked.html",
  // служебные страницы движка о Mozilla — пустая страница
  mozilla: "chrome://netloom/content/newtab.html",
  robots: "chrome://netloom/content/newtab.html",
  rights: "chrome://netloom/content/newtab.html",
  credits: "chrome://netloom/content/newtab.html",
  license: "chrome://netloom/content/newtab.html",
  logo: "chrome://netloom/content/newtab.html",
  welcome: "chrome://netloom/content/newtab.html",
};

/**
 * Свои страницы about:settings, about:newtab… Работают в главном процессе
 * (как родные настройки движка), поэтому им доступны все функции браузера.
 */
function registerAboutPages() {
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  for (const [what, target] of Object.entries(PAGES)) {
    const targetURI = Services.io.newURI(target);
    const module = {
      newChannel(uri, loadInfo) {
        const channel = Services.io.newChannelFromURIWithLoadInfo(targetURI, loadInfo);
        channel.originalURI = uri;
        return channel;
      },
      getURIFlags() {
        return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI | Ci.nsIAboutModule.HIDE_FROM_ABOUTABOUT;
      },
      getChromeURI() {
        return targetURI;
      },
      QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),
    };
    const factory = {
      createInstance(iid) {
        return module.QueryInterface(iid);
      },
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    };
    try {
      registrar.registerFactory(Services.uuid.generateUUID(), "NetLoom about:" + what,
        "@mozilla.org/network/protocol/about;1?what=" + what, factory);
    } catch (e) {
      report("about:" + what, e);
    }
  }
}

/** Скрытие рекламы: каждая страница получает только правила своего сайта */
function registerCosmeticActor() {
  ChromeUtils.registerWindowActor("NetLoomCosmetic", {
    parent: { esModuleURI: "chrome://netloom/content/CosmeticParent.sys.mjs" },
    child: {
      esModuleURI: "chrome://netloom/content/CosmeticChild.sys.mjs",
      events: { DOMDocElementInserted: { capture: true } },
    },
    matches: ["http://*/*", "https://*/*"],
    allFrames: true,
    messageManagerGroups: ["browsers"],
  });
}

function report(where, e) {
  Services.console.logStringMessage("NetLoom [" + where + "]: " + e + (e?.stack ? "\n" + e.stack : ""));
}

const Boot = {
  started: false,

  start() {
    if (this.started) return;
    this.started = true;
    registerAboutPages();
    try { registerCosmeticActor(); } catch (e) { report("cosmetic", e); }
    Services.obs.addObserver(this, "final-ui-startup");
    Services.obs.addObserver(this, "chrome-document-global-created");
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
  },

  observe(subject, topic) {
    try {
      if (topic === "final-ui-startup") {
        NetLoom.init();
        try {
          const { AboutNewTab } = ChromeUtils.importESModule("resource:///modules/AboutNewTab.sys.mjs");
          AboutNewTab.newTabURL = NEWTAB_URL;
        } catch (e) { report("newtab", e); }
      } else if (topic === "chrome-document-global-created") {
        subject.addEventListener("DOMContentLoaded", () => this.onDocument(subject), { once: true });
      } else if (topic === "browser-delayed-startup-finished") {
        this.onBrowserWindow(subject);
      }
    } catch (e) {
      report(topic, e);
    }
  },

  onDocument(win) {
    if (win.location.href !== BROWSER_URL) return;
    // стили — как можно раньше, чтобы старый интерфейс не мелькал
    win.windowUtils.loadSheetUsingURIString("chrome://netloom/content/browser.css", win.windowUtils.AUTHOR_SHEET);
  },

  onBrowserWindow(win) {
    if (win.location.href !== BROWSER_URL) return;
    try {
      Services.scriptloader.loadSubScript("chrome://netloom/content/browser-ui.js", win);
    } catch (e) {
      report("browser-ui", e);
    }
  },

  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
};

Boot.start();
