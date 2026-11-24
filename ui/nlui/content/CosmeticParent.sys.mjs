/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Скрытие рекламы: страница просит CSS для своего сайта — главный процесс отвечает.
// Так в процесс страницы попадают только правила этого сайта (несколько килобайт),
// а не правила всех сайтов сразу.
import { NetLoom } from "chrome://netloom/content/NetLoomService.sys.mjs";

export class NetLoomCosmeticParent extends JSWindowActorParent {
  receiveMessage(msg) {
    if (msg.name !== "css") return "";
    let host = "", top = "";
    try { host = this.manager.documentURI?.host || ""; } catch (e) {}
    try { top = this.browsingContext.top?.currentWindowGlobal?.documentURI?.host || ""; } catch (e) {}
    return NetLoom.cosmeticFor(host.toLowerCase(), top.toLowerCase());
  }
}
