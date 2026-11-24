/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});
const $ = id => document.getElementById(id);
const topWin = () => window.browsingContext?.topChromeWindow || null;
const hasSearch = () => !!searchService();
/** Служба поиска движка (в новых версиях — отдельный модуль) */
function searchService() {
  try {
    return ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs").SearchService;
  } catch (e) {
    return typeof Services !== "undefined" ? Services.search : null;
  }
}

// запасной список, если страница открыта в отдельном процессе без доступа к поиску браузера
const FALLBACK_ENGINES = [
  { name: "Google", url: "https://www.google.com/search?q=" },
  { name: "Яндекс", url: "https://yandex.ru/search/?text=" },
];

function navigate(url, where = "current") {
  const w = topWin();
  if (w?.openTrustedLinkIn) w.openTrustedLinkIn(url, where);
  else if (where === "tab") window.open(url, "_blank");
  else location.href = url;
}

function looksLikeAddress(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(localhost|[\w-]+(\.[\w-]+)+|\d+\.\d+\.\d+\.\d+)(:\d+)?([/?#].*)?$/i.test(s);
}

async function go(text) {
  text = text.trim();
  if (!text) return;
  let url;
  if (looksLikeAddress(text)) {
    url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "https://" + text;
  } else if (hasSearch()) {
    const search = searchService();
    const engine = search.getEngineByName($("engine").value) || (await search.getDefault());
    url = engine.getSubmission(text).uri.spec;
  } else {
    const e = FALLBACK_ENGINES.find(x => x.name === $("engine").value) || FALLBACK_ENGINES[0];
    url = e.url + encodeURIComponent(text);
  }
  navigate(url);
}

async function init() {
  let engines = FALLBACK_ENGINES, def = FALLBACK_ENGINES[0];
  if (hasSearch()) {
    try {
      engines = await searchService().getVisibleEngines();
      def = await searchService().getDefault();
    } catch (e) {}
  }
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
      a.addEventListener("click", ev => { ev.preventDefault(); navigate(b.uri, ev.ctrlKey || ev.button === 1 ? "tab" : "current"); });
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
