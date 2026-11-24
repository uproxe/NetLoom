/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package io.github.uproxe.netloom;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import org.mozilla.geckoview.ContentBlocking;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.StorageController;
import org.mozilla.geckoview.WebExtension;

/**
 * Движок NetLoom: один GeckoRuntime на всё приложение, встроенный модуль (блокировка рекламы,
 * защита, VPN) и связь с ним. Модуль присылает команды — запустить ядро VPN, скачать подписку,
 * проверить сервер; приложение присылает модулю нажатия на кнопку VPN.
 */
final class Engine implements WebExtension.MessageDelegate, WebExtension.PortDelegate {
  private static final String TAG = "NetLoom";
  static final String NATIVE_APP = "netloom";
  static final String EXT_ID = "netloom@uproxe";
  static final String EXT_URI = "resource://android/assets/netloom/";

  /** Состояние VPN для кнопки на панели */
  static final class VpnState {
    boolean on;
    String status = "off";
    String error = "";
    String server = "";
  }

  interface Listener {
    void onExtensionReady();

    void onVpnState(VpnState s);
  }

  private static Engine sInstance;

  final GeckoRuntime runtime;
  final SharedPreferences prefs;
  final Cores cores;
  private final Context context;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService pool = Executors.newCachedThreadPool();
  private final List<Listener> listeners = new ArrayList<>();
  private WebExtension extension;
  private WebExtension.Port port;
  final VpnState vpn = new VpnState();

  static synchronized Engine get(Context context) {
    if (sInstance == null) sInstance = new Engine(context.getApplicationContext());
    return sInstance;
  }

  private Engine(Context context) {
    this.context = context;
    prefs = context.getSharedPreferences("netloom", Context.MODE_PRIVATE);
    cores = new Cores(context);
    cores.setExitListener(
        log ->
            main.post(
                () -> {
                  final JSONObject e = event("core-exit");
                  try {
                    e.put("log", log);
                  } catch (Exception ignored) {
                    // не бывает
                  }
                  postToExtension(e);
                }));

    final GeckoRuntimeSettings settings =
        new GeckoRuntimeSettings.Builder()
            .contentBlocking(
                new ContentBlocking.Settings.Builder()
                    .antiTracking(ContentBlocking.AntiTracking.STRICT)
                    .enhancedTrackingProtectionLevel(ContentBlocking.EtpLevel.STRICT)
                    .cookieBehavior(ContentBlocking.CookieBehavior.ACCEPT_FIRST_PARTY_AND_ISOLATE_OTHERS)
                    .cookieBehaviorPrivateMode(
                        ContentBlocking.CookieBehavior.ACCEPT_FIRST_PARTY_AND_ISOLATE_OTHERS)
                    // проверка сайтов через Google выключена — свои списки во встроенном модуле
                    .safeBrowsing(ContentBlocking.SafeBrowsing.NONE)
                    // окна про куки: отказаться (1 = «отклонить»)
                    .cookieBannerHandlingMode(1)
                    .cookieBannerHandlingModePrivateBrowsing(1)
                    .queryParameterStrippingEnabled(true)
                    .queryParameterStrippingPrivateBrowsingEnabled(true)
                    .build())
            .allowInsecureConnections(GeckoRuntimeSettings.HTTPS_ONLY)
            .globalPrivacyControlEnabled(true)
            .locales(new String[] {"ru-RU", "ru", "en-US"})
            .aboutConfigEnabled(false)
            .remoteDebuggingEnabled(false)
            .consoleOutput(BuildConfig.DEBUG)
            .build();
    runtime = GeckoRuntime.create(context, settings);
    runtime.getSettings().setFingerprintingProtection(prefs.getBoolean("rfp", false));

    runtime
        .getWebExtensionController()
        .ensureBuiltIn(EXT_URI, EXT_ID)
        .accept(
            ext -> {
              extension = ext;
              ext.setMessageDelegate(this, NATIVE_APP);
              runtime.getWebExtensionController().setAllowedInPrivateBrowsing(ext, true);
              for (Listener l : new ArrayList<>(listeners)) l.onExtensionReady();
            },
            e -> Log.e(TAG, "встроенный модуль не загрузился", e));
  }

  void addListener(Listener l) {
    listeners.add(l);
    if (extension != null) l.onExtensionReady();
    l.onVpnState(vpn);
  }

  void removeListener(Listener l) {
    listeners.remove(l);
  }

  /** Адрес страниц встроенного модуля (moz-extension://…/) или null, пока он загружается */
  String extensionBase() {
    return extension == null ? null : extension.metaData.baseUrl;
  }

  String searchUrl(String query) {
    final String q = android.net.Uri.encode(query);
    switch (prefs.getString("search", "google")) {
      case "yandex":
        return "https://yandex.ru/search/?text=" + q;
      case "duckduckgo":
        return "https://duckduckgo.com/?q=" + q;
      default:
        return "https://www.google.com/search?q=" + q;
    }
  }

  void toggleVpn() {
    postToExtension(event("toggle-vpn"));
  }

  GeckoResult<Void> clearData() {
    return runtime
        .getStorageController()
        .clearData(StorageController.ClearFlags.SITE_DATA | StorageController.ClearFlags.ALL_CACHES);
  }

  void shutdown() {
    cores.stop();
  }

  // ───────── связь со встроенным модулем ─────────

  private static JSONObject event(String name) {
    final JSONObject o = new JSONObject();
    try {
      o.put("event", name);
    } catch (Exception ignored) {
      // не бывает
    }
    return o;
  }

  private void postToExtension(JSONObject msg) {
    if (port != null) port.postMessage(msg);
  }

  @Override
  public void onConnect(WebExtension.Port p) {
    port = p;
    p.setDelegate(this);
    postToExtension(event("hello"));
  }

  @Override
  public void onDisconnect(WebExtension.Port p) {
    if (port == p) port = null;
  }

  @Override
  public GeckoResult<Object> onMessage(String nativeApp, Object message, WebExtension.MessageSender sender) {
    return null;
  }

  @Override
  public void onPortMessage(Object message, WebExtension.Port p) {
    if (!(message instanceof JSONObject)) return;
    final JSONObject m = (JSONObject) message;
    final String ev = m.optString("event", "");
    if ("state".equals(ev)) {
      vpn.on = m.optBoolean("vpn");
      vpn.status = m.optString("status", "off");
      vpn.error = m.optString("error", "");
      vpn.server = m.optString("server", "");
      for (Listener l : new ArrayList<>(listeners)) l.onVpnState(vpn);
      return;
    }
    final int id = m.optInt("id", 0);
    final String cmd = m.optString("cmd", "");
    if (id == 0 || cmd.isEmpty()) return;
    pool.execute(
        () -> {
          JSONObject reply;
          try {
            reply = handle(cmd, m);
            reply.put("ok", true);
          } catch (Exception e) {
            reply = new JSONObject();
            try {
              reply.put("ok", false);
              reply.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
            } catch (Exception ignored) {
              // не бывает
            }
          }
          try {
            reply.put("id", id);
          } catch (Exception ignored) {
            // не бывает
          }
          final JSONObject r = reply;
          main.post(() -> {
            if (p == port) p.postMessage(r);
          });
        });
  }

  private JSONObject handle(String cmd, JSONObject m) throws Exception {
    final JSONObject r = new JSONObject();
    switch (cmd) {
      case "start":
        r.put("port", cores.start(m.getString("core"), m.getJSONObject("config")));
        return r;
      case "stop":
        cores.stop();
        return r;
      case "tcpping":
        r.put("ms", Cores.tcpPing(m.getString("host"), m.getInt("port"), 5000));
        return r;
      case "fetch":
        return fetch(m.getString("url"));
      case "appget":
        {
          final JSONObject s = new JSONObject();
          s.put("search", prefs.getString("search", "google"));
          s.put("rfp", prefs.getBoolean("rfp", false));
          s.put("clearOnExit", prefs.getBoolean("clearOnExit", false));
          s.put("version", BuildConfig.VERSION_NAME);
          s.put("engine", "Gecko " + BuildConfig.GECKOVIEW_VERSION);
          r.put("settings", s);
          return r;
        }
      case "appset":
        {
          final String key = m.getString("key");
          final SharedPreferences.Editor e = prefs.edit();
          if ("search".equals(key)) e.putString("search", m.getString("value"));
          else if ("rfp".equals(key) || "clearOnExit".equals(key)) e.putBoolean(key, m.getBoolean("value"));
          else throw new Exception("Неизвестная настройка");
          e.apply();
          if ("rfp".equals(key)) {
            final boolean v = m.getBoolean("value");
            main.post(() -> runtime.getSettings().setFingerprintingProtection(v));
          }
          return r;
        }
      case "action":
        {
          final String name = m.getString("name");
          if ("clearData".equals(name)) main.post(this::clearData);
          else if ("defaultBrowser".equals(name)) main.post(this::openDefaultAppsSettings);
          return r;
        }
      default:
        throw new Exception("Неизвестная команда " + cmd);
    }
  }

  /** Загрузка подписки VPN (заголовки нужны для трафика и срока действия) */
  private JSONObject fetch(String url) throws Exception {
    final HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setConnectTimeout(15000);
    c.setReadTimeout(20000);
    c.setRequestProperty("User-Agent", "v2rayN/7.0");
    c.setInstanceFollowRedirects(true);
    try {
      final int code = c.getResponseCode();
      if (code < 200 || code >= 300) throw new Exception("Сервер подписки ответил " + code);
      final ByteArrayOutputStream out = new ByteArrayOutputStream();
      try (InputStream in = c.getInputStream()) {
        final byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
          out.write(buf, 0, n);
          if (out.size() > 8 * 1024 * 1024) throw new Exception("Подписка слишком большая");
        }
      }
      final JSONObject h = new JSONObject();
      final String info = c.getHeaderField("subscription-userinfo");
      final String title = c.getHeaderField("profile-title");
      h.put("subscription-userinfo", info == null ? "" : info);
      h.put("profile-title", title == null ? "" : title);
      final JSONObject r = new JSONObject();
      r.put("body", new String(out.toByteArray(), StandardCharsets.UTF_8));
      r.put("headers", h);
      return r;
    } finally {
      c.disconnect();
    }
  }

  private void openDefaultAppsSettings() {
    Intent i;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      i = new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS);
    } else {
      i = new Intent(Settings.ACTION_SETTINGS);
    }
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      context.startActivity(i);
    } catch (Exception e) {
      context.startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
  }
}
