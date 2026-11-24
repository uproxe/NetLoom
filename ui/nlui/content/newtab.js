/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});
const $ = id => document.getElementById(id);
const topWin = () => window.browsingContext.topChromeWindow;

function looksLikeAddress(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(localhost|[\w-]+(\.[\w-]+)+|\d+\.\d+\.\d+\.\d+)(:\d+)?([/?#].*)?$/i.test(s);
}

async function go(text) {
  text = text.trim();
  if (!text) return;
  let url;
  if (looksLikeAddress(text)) {
    url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "https://" + text;
  } else {
    const engine = Services.search.getEngineByName($("engine").value) || (await Services.search.getDefault());
    url = engine.getSubmission(text).uri.spec;
  }
  topWin().openTrustedLinkIn(url, "current");
}

async function init() {
  const engines = await Services.search.getVisibleEngines();
  const def = await Services.search.getDefault();
  for (const e of engines) {
    const o = document.createElement("option");
    o.value = e.name;
    o.textContent = e.name;
    o.selected = e.name === def?.name;
    $("engine").append(o);
  }
  $("form").addEventListener("submit", ev => { ev.preventDefault(); go($("q").value); });
  $("q").focus();

  // плитки — первые закладки с панели закладок
  try {
    const tree = await lazy.PlacesUtils.promiseBookmarksTree(lazy.PlacesUtils.bookmarks.toolbarGuid);
    const links = (tree.children || []).filter(c => c.uri && /^https?:/.test(c.uri)).slice(0, 12);
    for (const b of links) {
      const a = document.createElement("a");
      a.className = "tile";
      a.href = b.uri;
      a.addEventListener("click", ev => { ev.preventDefault(); topWin().openTrustedLinkIn(b.uri, ev.ctrlKey || ev.button === 1 ? "tab" : "current"); });
      const ico = document.createElement("span");
      ico.className = "ico";
      ico.setAttribute("aria-hidden", "true");
      const img = document.createElement("img");
      img.src = "page-icon:" + b.uri;
      img.alt = "";
      img.addEventListener("error", () => { img.remove(); ico.textContent = (b.title || new URL(b.uri).hostname).trim().charAt(0).toUpperCase(); });
      ico.append(img);
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = b.title || new URL(b.uri).hostname;
      a.append(ico, t);
      $("tiles").append(a);
    }
  } catch (e) {
    console.error(e);
  }
}
init();
