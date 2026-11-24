/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package io.github.uproxe.netloom;

import android.content.Context;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import org.json.JSONObject;

/**
 * Ядра VPN: Xray-core и sing-box. Это обычные программы, они лежат внутри приложения
 * как lib*.so (так Android разрешает их запускать). Конфигурация передаётся через stdin —
 * ключи серверов не попадают на диск. Наружу ядро открывает только SOCKS5 на 127.0.0.1
 * с одноразовым логином и паролем.
 */
final class Cores {
  interface ExitListener {
    void onExit(String log);
  }

  private final Context context;
  private Process process;
  private final ArrayDeque<String> tail = new ArrayDeque<>();
  private ExitListener exitListener;

  Cores(Context context) {
    this.context = context.getApplicationContext();
  }

  void setExitListener(ExitListener l) {
    exitListener = l;
  }

  private File binary(String core) {
    final String dir = context.getApplicationInfo().nativeLibraryDir;
    return new File(dir, "sing-box".equals(core) ? "libsingbox.so" : "libxray.so");
  }

  /** Запускает ядро и ждёт, пока оно начнёт принимать подключения. Возвращает порт. */
  synchronized int start(String core, JSONObject config) throws Exception {
    stop();
    final File exe = binary(core);
    if (!exe.exists()) throw new Exception("Нет ядра VPN " + core + " в этой сборке");
    final int port = freePort();
    final JSONObject inbound = config.getJSONArray("inbounds").getJSONObject(0);
    if ("sing-box".equals(core)) inbound.put("listen_port", port);
    else inbound.put("port", port);

    final File work = new File(context.getFilesDir(), "core");
    work.mkdirs();
    final ProcessBuilder pb =
        "sing-box".equals(core)
            ? new ProcessBuilder(exe.getAbsolutePath(), "run", "-c", "stdin", "-D", work.getAbsolutePath())
            : new ProcessBuilder(exe.getAbsolutePath(), "run", "-config", "stdin:");
    pb.directory(work);
    pb.redirectErrorStream(true);
    pb.environment().put("XRAY_LOCATION_ASSET", work.getAbsolutePath());
    final Process p = pb.start();
    process = p;
    synchronized (tail) {
      tail.clear();
    }

    try (OutputStream in = p.getOutputStream()) {
      in.write(config.toString().getBytes(StandardCharsets.UTF_8));
    }

    final Thread reader =
        new Thread(
            () -> {
              try (BufferedReader r =
                  new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                  synchronized (tail) {
                    tail.add(line);
                    while (tail.size() > 40) tail.poll();
                  }
                }
              } catch (Exception ignored) {
                // поток закрылся вместе с ядром
              }
              try {
                p.waitFor();
              } catch (InterruptedException ignored) {
                // выходим
              }
              final boolean current;
              synchronized (Cores.this) {
                current = process == p;
                if (current) process = null;
              }
              if (current && exitListener != null) exitListener.onExit(log());
            },
            "netloom-core");
    reader.setDaemon(true);
    reader.start();

    final long deadline = System.currentTimeMillis() + 10000;
    while (System.currentTimeMillis() < deadline) {
      if (!isAlive(p)) throw new Exception("Ядро VPN не запустилось: " + lastLine());
      if (tcpPing("127.0.0.1", port, 400) >= 0) return port;
      Thread.sleep(150);
    }
    stop();
    throw new Exception("Ядро VPN не ответило вовремя");
  }

  synchronized void stop() {
    final Process p = process;
    process = null;
    if (p != null) p.destroy();
  }

  private static boolean isAlive(Process p) {
    try {
      p.exitValue();
      return false;
    } catch (IllegalThreadStateException e) {
      return true;
    }
  }

  String log() {
    synchronized (tail) {
      return String.join("\n", tail);
    }
  }

  private String lastLine() {
    synchronized (tail) {
      final String l = tail.peekLast();
      return l == null ? "" : l;
    }
  }

  static int freePort() throws Exception {
    try (ServerSocket s = new ServerSocket(0)) {
      s.setReuseAddress(true);
      return s.getLocalPort();
    }
  }

  /** Время установки TCP-соединения в миллисекундах или -1 */
  static int tcpPing(String host, int port, int timeoutMs) {
    final long t = System.nanoTime();
    try (Socket s = new Socket()) {
      s.connect(new InetSocketAddress(host, port), timeoutMs);
      return (int) ((System.nanoTime() - t) / 1_000_000);
    } catch (Exception e) {
      return -1;
    }
  }
}
