/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Скрытие рекламы в странице: как только появился документ, берём CSS своего сайта
// и подключаем его пользовательской таблицей стилей (её не видят и не могут отменить скрипты сайта).
export class NetLoomCosmeticChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type !== "DOMDocElementInserted" || event.target !== this.document) return;
    this.sendQuery("css").then(css => {
      if (!css) return;
      try {
        this.contentWindow.windowUtils.loadSheetUsingURIString(
          "data:text/css;charset=utf-8," + encodeURIComponent(css), Ci.nsIDOMWindowUtils.USER_SHEET);
      } catch (e) {
        // страницу уже закрыли или ушли с неё
      }
    }, () => {});
  }
}
