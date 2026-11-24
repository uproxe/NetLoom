/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// NetLoom: запуск службы и подключение интерфейса к каждому окну браузера.
import { NetLoom } from "chrome://netloom/content/NetLoomService.sys.mjs";

const BROWSER_URL = "chrome://browser/content/browser.xhtml";
export const NEWTAB_URL = "chrome://netloom/content/newtab.html";
export const SETTINGS_URL = "chrome://netloom/content/settings.html";

function report(where, e) {
  Services.console.logStringMessage("NetLoom [" + where + "]: " + e + (e?.stack ? "\n" + e.stack : ""));
}

const Boot = {
  started: false,

  start() {
    if (this.started) return;
    this.started = true;
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
