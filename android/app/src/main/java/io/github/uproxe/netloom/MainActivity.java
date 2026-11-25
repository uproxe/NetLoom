/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package io.github.uproxe.netloom;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PictureInPictureParams;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.Patterns;
import android.util.Rational;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSession.PermissionDelegate.ContentPermission;
import org.mozilla.geckoview.GeckoSession.PermissionDelegate.MediaSource;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebRequestError;
import org.mozilla.geckoview.WebResponse;

/** Окно браузера: вкладки, адресная строка, кнопка VPN и меню. Всё остальное — страница сайта. */
public class MainActivity extends Activity implements Engine.Listener {
  private static final int REQUEST_FILE = 1;
  private static final int REQUEST_PERMISSIONS = 2;

  /** Одна вкладка */
  private final class Tab {
    final GeckoSession session;
    final boolean priv;
    String url = "";
    String title = "";
    boolean canBack;
    boolean canForward;
    boolean desktop;
    int progress = 100;

    Tab(GeckoSession session, boolean priv) {
      this.session = session;
      this.priv = priv;
    }
  }

  private Engine engine;
  private GeckoView geckoView;
  private EditText urlBar;
  private TextView tabsButton;
  private TextView vpnButton;
  private ProgressBar progress;
  private View toolbar;
  private Prompt prompt;
  private final List<Tab> tabs = new ArrayList<>();
  private Tab current;
  private boolean fullScreen;
  private String pendingUrl;
  private boolean started;
  private GeckoSession.PermissionDelegate.Callback permissionCallback;

  // ═════════ жизненный цикл ═════════

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    setContentView(R.layout.activity_main);
    geckoView = findViewById(R.id.gecko);
    urlBar = findViewById(R.id.url);
    tabsButton = findViewById(R.id.tabs);
    vpnButton = findViewById(R.id.vpn);
    progress = findViewById(R.id.progress);
    toolbar = findViewById(R.id.toolbar);
    prompt = new Prompt(this);
    prompt.filePickerRequestCode = REQUEST_FILE;

    urlBar.setOnEditorActionListener(
        (v, actionId, event) -> {
          final boolean enter =
              actionId == EditorInfo.IME_ACTION_GO
                  || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN);
          if (!enter) return false;
          go(urlBar.getText().toString());
          return true;
        });
    urlBar.setOnFocusChangeListener((v, has) -> {
      if (!has) showUrl();
    });
    tabsButton.setOnClickListener(v -> showTabs());
    vpnButton.setOnClickListener(v -> onVpnClick());
    vpnButton.setOnLongClickListener(v -> {
      openSettings("#vpn");
      return true;
    });
    findViewById(R.id.menu).setOnClickListener(this::showMenu);

    pendingUrl = urlFromIntent(getIntent());
    engine = Engine.get(this);
    engine.addListener(this);
    // если модуль долго загружается — открываем первую вкладку без него
    geckoView.postDelayed(this::startOnce, 4000);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    final String url = urlFromIntent(intent);
    if (url != null) {
      if (started) newTab(url, false);
      else pendingUrl = url;
    }
  }

  @Override
  public void onExtensionReady() {
    startOnce();
  }

  private void startOnce() {
    if (started) return;
    started = true;
    newTab(pendingUrl != null ? pendingUrl : homeUrl(), false);
    pendingUrl = null;
  }

  @Override
  protected void onDestroy() {
    engine.removeListener(this);
    if (isFinishing()) {
      for (Tab t : tabs) t.session.close();
      tabs.clear();
      engine.shutdown();
    }
    super.onDestroy();
  }

  // ═════════ видео в отдельном окне ═════════

  /** Если смотрят видео на весь экран и уходят из приложения — видео продолжается в маленьком окне */
  @Override
  protected void onUserLeaveHint() {
    super.onUserLeaveHint();
    if (fullScreen) enterVideoWindow();
  }

  private void enterVideoWindow() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    try {
      enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(new Rational(16, 9)).build());
    } catch (Exception e) {
      Toast.makeText(this, "Окно поверх других приложений недоступно", Toast.LENGTH_SHORT).show();
    }
  }

  @Override
  public void onPictureInPictureModeChanged(boolean inPip, android.content.res.Configuration config) {
    super.onPictureInPictureModeChanged(inPip, config);
    toolbar.setVisibility(inPip || fullScreen ? View.GONE : View.VISIBLE);
    progress.setVisibility(inPip || fullScreen ? View.GONE : View.INVISIBLE);
  }

  @Override
  public void onBackPressed() {
    if (fullScreen && current != null) {
      current.session.exitFullScreen();
      return;
    }
    if (urlBar.hasFocus()) {
      urlBar.clearFocus();
      hideKeyboard();
      return;
    }
    if (current != null && current.canBack) {
      current.session.goBack();
      return;
    }
    if (current != null && tabs.size() > 1) {
      closeTab(current);
      return;
    }
    moveTaskToBack(true);
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQUEST_FILE) prompt.onFileCallbackResult(resultCode, data);
    else super.onActivityResult(requestCode, resultCode, data);
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    if (requestCode != REQUEST_PERMISSIONS || permissionCallback == null) return;
    final GeckoSession.PermissionDelegate.Callback cb = permissionCallback;
    permissionCallback = null;
    for (int r : results) {
      if (r != PackageManager.PERMISSION_GRANTED) {
        cb.reject();
        return;
      }
    }
    cb.grant();
  }

  private static String urlFromIntent(Intent intent) {
    if (intent == null) return null;
    if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
      return intent.getData().toString();
    }
    if (Intent.ACTION_SEND.equals(intent.getAction())) {
      final String text = intent.getStringExtra(Intent.EXTRA_TEXT);
      if (text != null) return text.trim();
    }
    if (Intent.ACTION_WEB_SEARCH.equals(intent.getAction())) {
      final String q = intent.getStringExtra("query");
      if (q != null) return q;
    }
    return null;
  }

  // ═════════ адреса ═════════

  private String homeUrl() {
    final String base = engine.extensionBase();
    return base != null ? base + "pages/newtab.html" : "about:blank";
  }

  private boolean isInternal(String url) {
    final String base = engine.extensionBase();
    return url == null || url.isEmpty() || "about:blank".equals(url) || (base != null && url.startsWith(base));
  }

  /** Текст из адресной строки → адрес сайта или поиск */
  private void go(String text) {
    text = text.trim();
    if (text.isEmpty()) return;
    urlBar.clearFocus();
    hideKeyboard();
    load(toUrl(text));
  }

  private String toUrl(String text) {
    text = text.trim();
    if (text.matches("(?i)^(https?|about|data|blob|file|view-source|moz-extension):.*")) return text;
    if (!text.contains(" ") && (Patterns.WEB_URL.matcher(text).matches() || text.matches("^[\\w.-]+(:\\d+)?(/.*)?$") && text.contains("."))) {
      return "https://" + text;
    }
    if (text.matches("^(localhost|\\d{1,3}(\\.\\d{1,3}){3})(:\\d+)?(/.*)?$")) return "http://" + text;
    return engine.searchUrl(text);
  }

  private void load(String url) {
    if (current == null) newTab(url, false);
    else current.session.loadUri(url);
  }

  private void showUrl() {
    if (current == null || urlBar.hasFocus()) return;
    final String base = engine.extensionBase();
    if (isInternal(current.url)) {
      urlBar.setText(base != null && current.url.startsWith(base + "pages/settings.html") ? "Настройки" : "");
    } else {
      urlBar.setText(current.url);
    }
    urlBar.setHint(current.priv ? "Приватная вкладка — поиск или адрес" : getString(R.string.url_hint));
  }

  private void hideKeyboard() {
    final InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
    if (imm != null) imm.hideSoftInputFromWindow(urlBar.getWindowToken(), 0);
  }

  // ═════════ вкладки ═════════

  private Tab newTab(String url, boolean priv) {
    final Tab t = createTab(priv, false);
    t.session.open(engine.runtime);
    tabs.add(t);
    select(t);
    t.session.loadUri(url);
    return t;
  }

  private Tab createTab(boolean priv, boolean desktop) {
    final GeckoSessionSettings settings =
        new GeckoSessionSettings.Builder()
            .usePrivateMode(priv)
            .useTrackingProtection(true)
            .userAgentMode(desktop ? GeckoSessionSettings.USER_AGENT_MODE_DESKTOP : GeckoSessionSettings.USER_AGENT_MODE_MOBILE)
            .viewportMode(desktop ? GeckoSessionSettings.VIEWPORT_MODE_DESKTOP : GeckoSessionSettings.VIEWPORT_MODE_MOBILE)
            .build();
    final GeckoSession s = new GeckoSession(settings);
    final Tab t = new Tab(s, priv);
    t.desktop = desktop;
    s.setNavigationDelegate(new Navigation(t));
    s.setProgressDelegate(new Progress(t));
    s.setContentDelegate(new Content(t));
    s.setPermissionDelegate(new Permissions());
    s.setPromptDelegate(prompt);
    return t;
  }

  private void select(Tab t) {
    if (current == t) return;
    final org.mozilla.geckoview.WebExtensionController ctl = engine.runtime.getWebExtensionController();
    if (current != null && current.session.isOpen()) ctl.setTabActive(current.session, false);
    current = t;
    geckoView.releaseSession();
    geckoView.setSession(t.session);
    if (t.session.isOpen()) ctl.setTabActive(t.session, true);
    showUrl();
    updateProgress();
    updateTabsButton();
  }

  private void closeTab(Tab t) {
    final int i = tabs.indexOf(t);
    if (i < 0) return;
    tabs.remove(i);
    if (t == current) {
      current = null;
      geckoView.releaseSession();
    }
    t.session.close();
    if (tabs.isEmpty()) newTab(homeUrl(), false);
    else if (current == null) select(tabs.get(Math.max(0, i - 1)));
    updateTabsButton();
  }

  private void updateTabsButton() {
    final int n = tabs.size();
    tabsButton.setText(n > 99 ? ":)" : String.valueOf(n));
    tabsButton.setTextColor(getColor(current != null && current.priv ? R.color.accent : R.color.text));
  }

  private void updateProgress() {
    if (current == null || current.progress >= 100) {
      progress.setVisibility(View.INVISIBLE);
    } else {
      progress.setVisibility(View.VISIBLE);
      progress.setProgress(Math.max(5, current.progress));
    }
  }

  private void showTabs() {
    final List<String> items = new ArrayList<>();
    for (Tab t : tabs) {
      String name = !TextUtils.isEmpty(t.title) ? t.title : isInternal(t.url) ? "Новая вкладка" : t.url;
      if (t.priv) name = "🔒 " + name;
      if (t == current) name = "● " + name;
      items.add(name);
    }
    final AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("Вкладки: " + tabs.size())
            .setAdapter(
                new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, items),
                (d, which) -> select(tabs.get(which)))
            .setPositiveButton("Новая", (d, w) -> newTab(homeUrl(), false))
            .setNeutralButton("Приватная", (d, w) -> newTab(homeUrl(), true))
            .setNegativeButton("Закрыть текущую", (d, w) -> {
              if (current != null) closeTab(current);
            })
            .create();
    dialog.setOnShowListener(
        d ->
            dialog
                .getListView()
                .setOnItemLongClickListener(
                    (parent, view, position, id) -> {
                      closeTab(tabs.get(position));
                      dialog.dismiss();
                      return true;
                    }));
    dialog.show();
  }

  // ═════════ VPN ═════════

  @Override
  public void onVpnState(Engine.VpnState s) {
    int bg = R.drawable.bg_vpn_off;
    int color = R.color.muted;
    if (s.on) {
      switch (s.status) {
        case "connected":
          bg = R.drawable.bg_vpn_on;
          color = R.color.ok;
          break;
        case "connecting":
          bg = R.drawable.bg_vpn_wait;
          color = R.color.warn;
          break;
        case "error":
          bg = R.drawable.bg_vpn_err;
          color = R.color.bad;
          break;
        default:
          break;
      }
    }
    vpnButton.setBackgroundResource(bg);
    vpnButton.setTextColor(getColor(color));
    if (s.on && "error".equals(s.status) && !TextUtils.isEmpty(s.error)) {
      Toast.makeText(this, s.error, Toast.LENGTH_LONG).show();
      if (s.error.contains("Добавьте сервер")) openSettings("#vpn");
    } else if (s.on && "connected".equals(s.status) && !TextUtils.isEmpty(s.server)) {
      vpnButton.setContentDescription("VPN: " + s.server);
    }
  }

  private void onVpnClick() {
    if (engine.extensionBase() == null) {
      Toast.makeText(this, "NetLoom ещё запускается…", Toast.LENGTH_SHORT).show();
      return;
    }
    engine.toggleVpn();
  }

  private void openSettings(String hash) {
    final String base = engine.extensionBase();
    if (base == null) return;
    final String url = base + "pages/settings.html" + (hash == null ? "" : hash);
    for (Tab t : tabs) {
      if (t.url.startsWith(base + "pages/settings.html")) {
        select(t);
        t.session.loadUri(url);
        return;
      }
    }
    newTab(url, false);
  }

  // ═════════ меню ═════════

  private void showMenu(View anchor) {
    final PopupMenu pm = new PopupMenu(this, anchor);
    final Menu m = pm.getMenu();
    final boolean page = current != null && !isInternal(current.url);
    m.add(0, 1, 0, "Новая вкладка");
    m.add(0, 2, 0, "Приватная вкладка");
    m.add(0, 3, 0, "Закладки");
    if (page) m.add(0, 4, 0, isBookmarked(current.url) ? "Убрать из закладок" : "Добавить в закладки");
    if (current != null && current.canForward) m.add(0, 5, 0, "Вперёд");
    if (page) m.add(0, 6, 0, "Обновить");
    if (page) m.add(0, 7, 0, "Поделиться");
    if (page) m.add(0, 8, 0, "Скопировать адрес");
    if (current != null) m.add(0, 9, 0, current.desktop ? "Мобильная версия сайта" : "Версия для компьютера");
    m.add(0, 10, 0, "Настройки и VPN");
    m.add(0, 11, 0, "Выход");
    pm.setOnMenuItemClickListener(
        item -> {
          switch (item.getItemId()) {
            case 1: newTab(homeUrl(), false); break;
            case 2: newTab(homeUrl(), true); break;
            case 3: showBookmarks(); break;
            case 4: toggleBookmark(); break;
            case 5: current.session.goForward(); break;
            case 6: current.session.reload(); break;
            case 7: share(); break;
            case 8: copyUrl(); break;
            case 9: toggleDesktop(); break;
            case 10: openSettings(null); break;
            case 11: exit(); break;
            default: return false;
          }
          return true;
        });
    pm.show();
  }

  private void share() {
    final Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, current.url);
    startActivity(Intent.createChooser(i, "Поделиться"));
  }

  private void copyUrl() {
    final ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("url", current.url));
    Toast.makeText(this, "Адрес скопирован", Toast.LENGTH_SHORT).show();
  }

  private void toggleDesktop() {
    final Tab old = current;
    final String url = old.url;
    final Tab t = createTab(old.priv, !old.desktop);
    t.session.open(engine.runtime);
    tabs.set(tabs.indexOf(old), t);
    current = null;
    select(t);
    old.session.close();
    t.session.loadUri(isInternal(url) ? homeUrl() : url);
  }

  private void exit() {
    if (engine.prefs.getBoolean("clearOnExit", false)) {
      engine.clearData().accept(v -> finishAndRemoveTask(), e -> finishAndRemoveTask());
    } else {
      finishAndRemoveTask();
    }
  }

  // ═════════ закладки ═════════

  private JSONArray bookmarks() {
    try {
      return new JSONArray(engine.prefs.getString("bookmarks", "[]"));
    } catch (Exception e) {
      return new JSONArray();
    }
  }

  private void saveBookmarks(JSONArray a) {
    engine.prefs.edit().putString("bookmarks", a.toString()).apply();
  }

  private boolean isBookmarked(String url) {
    final JSONArray a = bookmarks();
    for (int i = 0; i < a.length(); i++) if (url.equals(a.optJSONObject(i).optString("u"))) return true;
    return false;
  }

  private void toggleBookmark() {
    final JSONArray a = bookmarks();
    final JSONArray out = new JSONArray();
    boolean removed = false;
    for (int i = 0; i < a.length(); i++) {
      final JSONObject b = a.optJSONObject(i);
      if (current.url.equals(b.optString("u"))) removed = true;
      else out.put(b);
    }
    if (!removed) {
      try {
        out.put(new JSONObject().put("u", current.url).put("t", TextUtils.isEmpty(current.title) ? current.url : current.title));
      } catch (Exception ignored) {
        // не бывает
      }
    }
    saveBookmarks(out);
    Toast.makeText(this, removed ? "Убрано из закладок" : "Добавлено в закладки", Toast.LENGTH_SHORT).show();
  }

  private void showBookmarks() {
    final JSONArray a = bookmarks();
    if (a.length() == 0) {
      new AlertDialog.Builder(this)
          .setTitle("Закладки")
          .setMessage("Закладок пока нет. Откройте сайт и выберите в меню «Добавить в закладки».")
          .setPositiveButton(android.R.string.ok, null)
          .show();
      return;
    }
    final List<String> items = new ArrayList<>();
    for (int i = 0; i < a.length(); i++) items.add(a.optJSONObject(i).optString("t"));
    final AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("Закладки")
            .setAdapter(
                new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, items),
                (d, which) -> load(a.optJSONObject(which).optString("u")))
            .setNegativeButton("Закрыть", null)
            .create();
    dialog.setOnShowListener(
        d ->
            dialog
                .getListView()
                .setOnItemLongClickListener(
                    (parent, view, position, id) -> {
                      new AlertDialog.Builder(this)
                          .setMessage("Удалить закладку «" + items.get(position) + "»?")
                          .setPositiveButton("Удалить", (x, y) -> {
                            final JSONArray out = new JSONArray();
                            for (int i = 0; i < a.length(); i++) if (i != position) out.put(a.optJSONObject(i));
                            saveBookmarks(out);
                            dialog.dismiss();
                          })
                          .setNegativeButton("Отмена", null)
                          .show();
                      return true;
                    }));
    dialog.show();
  }

  // ═════════ полноэкранный режим ═════════

  private void setFullScreen(boolean on) {
    fullScreen = on;
    toolbar.setVisibility(on ? View.GONE : View.VISIBLE);
    progress.setVisibility(on ? View.GONE : View.INVISIBLE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      final WindowInsetsController c = getWindow().getInsetsController();
      if (c != null) {
        if (on) {
          c.hide(WindowInsets.Type.systemBars());
          c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } else {
          c.show(WindowInsets.Type.systemBars());
        }
      }
    } else {
      getWindow()
          .getDecorView()
          .setSystemUiVisibility(
              on
                  ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                  : 0);
    }
  }

  // ═════════ загрузки ═════════

  private static String fileName(WebResponse r) {
    String name = null;
    final String cd = r.headers.get("Content-Disposition");
    if (cd != null) {
      final java.util.regex.Matcher m = java.util.regex.Pattern.compile("filename\\*?=(?:UTF-8'')?\"?([^\";]+)").matcher(cd);
      if (m.find()) name = Uri.decode(m.group(1));
    }
    if (TextUtils.isEmpty(name)) name = Uri.parse(r.uri).getLastPathSegment();
    if (TextUtils.isEmpty(name)) name = "download";
    return name.replaceAll("[\\\\/:*?\"<>|]", "_");
  }

  private void download(WebResponse response) {
    if (response.body == null) return;
    final String name = fileName(response);
    String mime = response.headers.get("Content-Type");
    if (mime != null) mime = mime.split(";")[0].trim();
    if (TextUtils.isEmpty(mime)) mime = "application/octet-stream";
    final String type = mime;
    Toast.makeText(this, "Скачиваю " + name, Toast.LENGTH_SHORT).show();
    new Thread(
            () -> {
              String where;
              try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                  final ContentResolver cr = getContentResolver();
                  final ContentValues v = new ContentValues();
                  v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                  v.put(MediaStore.MediaColumns.MIME_TYPE, type);
                  v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                  v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                  final Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                  if (uri == null) throw new Exception("нет доступа к папке «Загрузки»");
                  try (InputStream in = response.body;
                      OutputStream out = cr.openOutputStream(uri)) {
                    copy(in, out);
                  }
                  v.clear();
                  v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                  cr.update(uri, v, null, null);
                  where = "Загрузки";
                } else {
                  final File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                  if (dir == null) throw new Exception("нет доступа к памяти");
                  dir.mkdirs();
                  final File f = new File(dir, name);
                  try (InputStream in = response.body;
                      OutputStream out = new FileOutputStream(f)) {
                    copy(in, out);
                  }
                  where = f.getAbsolutePath();
                }
                final String msg = "Скачано: " + name + " → " + where;
                runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
              } catch (Exception e) {
                final String msg = "Не удалось скачать " + name + ": " + e.getMessage();
                runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
              }
            },
            "netloom-download")
        .start();
  }

  private static void copy(InputStream in, OutputStream out) throws Exception {
    if (out == null) throw new Exception("нет доступа к файлу");
    final byte[] buf = new byte[65536];
    int n;
    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
  }

  // ═════════ делегаты GeckoView ═════════

  private final class Navigation implements GeckoSession.NavigationDelegate {
    private final Tab tab;

    Navigation(Tab tab) {
      this.tab = tab;
    }

    @Override
    public void onLocationChange(GeckoSession session, String url, List<ContentPermission> perms, Boolean hasUserGesture) {
      tab.url = url == null ? "" : url;
      if (tab == current) showUrl();
    }

    @Override
    public void onCanGoBack(GeckoSession session, boolean canGoBack) {
      tab.canBack = canGoBack;
    }

    @Override
    public void onCanGoForward(GeckoSession session, boolean canGoForward) {
      tab.canForward = canGoForward;
    }

    @Override
    public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession session, LoadRequest request) {
      final String uri = request.uri;
      final String scheme = Uri.parse(uri).getScheme();
      if (scheme == null) return GeckoResult.fromValue(AllowOrDeny.ALLOW);
      switch (scheme.toLowerCase(Locale.ROOT)) {
        case "http": case "https": case "about": case "data": case "blob": case "file":
        case "moz-extension": case "resource": case "javascript": case "view-source":
          return GeckoResult.fromValue(AllowOrDeny.ALLOW);
        default:
          // tel:, mailto:, intent:, market: … — открываем в подходящем приложении
          openExternal(uri);
          return GeckoResult.fromValue(AllowOrDeny.DENY);
      }
    }

    @Override
    public GeckoResult<GeckoSession> onNewSession(GeckoSession session, String uri) {
      final Tab t = createTab(tab.priv, tab.desktop);
      tabs.add(tabs.indexOf(tab) + 1, t);
      select(t);
      return GeckoResult.fromValue(t.session);
    }

    @Override
    public GeckoResult<String> onLoadError(GeckoSession session, String uri, WebRequestError error) {
      return null; // страницу ошибки показывает движок
    }
  }

  private void openExternal(String uri) {
    try {
      final Intent i =
          uri.startsWith("intent:") ? Intent.parseUri(uri, Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
      i.addCategory(Intent.CATEGORY_BROWSABLE);
      i.setComponent(null);
      i.setSelector(null);
      startActivity(i);
    } catch (Exception e) {
      Toast.makeText(this, "Нет приложения, чтобы открыть эту ссылку", Toast.LENGTH_SHORT).show();
    }
  }

  private final class Progress implements GeckoSession.ProgressDelegate {
    private final Tab tab;

    Progress(Tab tab) {
      this.tab = tab;
    }

    @Override
    public void onPageStart(GeckoSession session, String url) {
      tab.progress = 5;
      if (tab == current) updateProgress();
    }

    @Override
    public void onPageStop(GeckoSession session, boolean success) {
      tab.progress = 100;
      if (tab == current) updateProgress();
    }

    @Override
    public void onProgressChange(GeckoSession session, int p) {
      tab.progress = p;
      if (tab == current) updateProgress();
    }
  }

  private final class Content implements GeckoSession.ContentDelegate {
    private final Tab tab;

    Content(Tab tab) {
      this.tab = tab;
    }

    @Override
    public void onTitleChange(GeckoSession session, String title) {
      tab.title = title == null ? "" : title;
    }

    @Override
    public void onFullScreen(GeckoSession session, boolean full) {
      if (tab == current) setFullScreen(full);
    }

    @Override
    public void onCloseRequest(GeckoSession session) {
      closeTab(tab);
    }

    @Override
    public void onExternalResponse(GeckoSession session, WebResponse response) {
      download(response);
    }

    @Override
    public void onCrash(GeckoSession session) {
      restart();
    }

    @Override
    public void onKill(GeckoSession session) {
      restart();
    }

    private void restart() {
      final int i = tabs.indexOf(tab);
      if (i < 0) return;
      final Tab t = createTab(tab.priv, tab.desktop);
      t.session.open(engine.runtime);
      tabs.set(i, t);
      if (tab == current) {
        current = null;
        select(t);
      }
      t.session.loadUri(isInternal(tab.url) ? homeUrl() : tab.url);
    }

    @Override
    public void onContextMenu(GeckoSession session, int screenX, int screenY, ContextElement element) {
      final String link = element.linkUri;
      final String src = element.srcUri;
      if (link == null && src == null) return;
      final List<String> labels = new ArrayList<>();
      final List<Runnable> actions = new ArrayList<>();
      if (link != null) {
        labels.add("Открыть в новой вкладке");
        actions.add(() -> newTab(link, tab.priv));
        labels.add("Открыть в приватной вкладке");
        actions.add(() -> newTab(link, true));
        labels.add("Скопировать ссылку");
        actions.add(() -> {
          final ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
          if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("url", link));
        });
      }
      if (src != null && element.type == ContextElement.TYPE_IMAGE) {
        labels.add("Открыть изображение");
        actions.add(() -> newTab(src, tab.priv));
      }
      new AlertDialog.Builder(MainActivity.this)
          .setTitle(link != null ? link : src)
          .setItems(labels.toArray(new String[0]), (d, which) -> actions.get(which).run())
          .show();
    }
  }

  private final class Permissions implements GeckoSession.PermissionDelegate {
    @Override
    public void onAndroidPermissionsRequest(GeckoSession session, String[] permissions, Callback callback) {
      if (permissions == null || permissions.length == 0) {
        callback.grant();
        return;
      }
      permissionCallback = callback;
      requestPermissions(permissions, REQUEST_PERMISSIONS);
    }

    @Override
    public GeckoResult<Integer> onContentPermissionRequest(GeckoSession session, ContentPermission perm) {
      final int res;
      switch (perm.permission) {
        case PERMISSION_GEOLOCATION:
          res = R.string.request_geolocation;
          break;
        case PERMISSION_DESKTOP_NOTIFICATION:
          res = R.string.request_notification;
          break;
        case PERMISSION_PERSISTENT_STORAGE:
          res = R.string.request_storage;
          break;
        case PERMISSION_MEDIA_KEY_SYSTEM_ACCESS:
          res = R.string.request_media_key_system_access;
          break;
        case PERMISSION_STORAGE_ACCESS:
          res = R.string.request_storage_access;
          break;
        case PERMISSION_AUTOPLAY_INAUDIBLE:
          return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
        default:
          return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
      }
      final String host = Uri.parse(perm.uri).getAuthority();
      return prompt.onPermissionPrompt(session, getString(res, host), perm);
    }

    @Override
    public void onMediaPermissionRequest(
        GeckoSession session, String uri, MediaSource[] video, MediaSource[] audio, MediaCallback callback) {
      if ((audio != null && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
          || (video != null && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)) {
        callback.reject();
        return;
      }
      final String host = Uri.parse(uri).getAuthority();
      final String title =
          getString(audio == null ? R.string.request_video : video == null ? R.string.request_audio : R.string.request_media, host);
      prompt.onMediaPrompt(session, title, video, audio, names(video), names(audio), callback);
    }

    private String[] names(MediaSource[] sources) {
      if (sources == null) return null;
      final String[] out = new String[sources.length];
      for (int i = 0; i < sources.length; i++) {
        final MediaSource s = sources[i];
        if (s.source == MediaSource.SOURCE_CAMERA) {
          out[i] = getString(s.name != null && s.name.toLowerCase(Locale.ROOT).contains("front") ? R.string.media_front_camera : R.string.media_back_camera);
        } else if (s.name != null && !s.name.isEmpty()) {
          out[i] = s.name;
        } else if (s.source == MediaSource.SOURCE_MICROPHONE) {
          out[i] = getString(R.string.media_microphone);
        } else {
          out[i] = getString(R.string.media_other);
        }
      }
      return out;
    }
  }
}
