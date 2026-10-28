package com.miranotes.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Available only to the bundled document; no files, shell, or general native APIs. */
public final class AndroidBridge implements AutoCloseable {
    private final Activity activity;
    private final WebView web;
    private SharedPreferences preferences;
    private PhoneSyncServer server;
    private PhoneIdentity identity;
    private ThreadPoolExecutor workers;
    private volatile boolean closed;
    private BackupTransfer backup;
    private volatile boolean exportPicking;

    AndroidBridge(Activity activity, WebView web) {
        this.activity = activity; this.web = web;
    }

    private synchronized ThreadPoolExecutor executor() throws IOException {
        if (closed) throw new IOException("Reopen NoteMark to connect.");
        if (workers == null) workers = new ThreadPoolExecutor(2, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(24),
            new java.util.concurrent.ThreadFactory() {
                @Override public Thread newThread(Runnable task) {
                    Thread thread = new Thread(task, "Mira-native-transport"); thread.setDaemon(true); return thread;
                }
            });
        return workers;
    }
    private synchronized PhoneSyncServer phoneServer() throws IOException {
        if (closed) throw new IOException("Reopen NoteMark to connect.");
        if (server == null) {
            try {
                if (identity == null) identity = new PhoneIdentity();
                server = new PhoneSyncServer(new File(activity.getFilesDir(), "phone-sync-data"), identity.context);
            } catch (Exception failure) {
                throw new IOException("The phone's secure identity could not be opened. Your notes remain saved.", failure);
            }
        }
        return server;
    }

    @JavascriptInterface public void postMessage(String serialized) {
        if (closed || serialized == null || serialized.length() > NativeHttp.MAX_BODY + 8192) return;
        // WebView APIs must be read on the UI thread. No remote navigation or frames are allowed.
        activity.runOnUiThread(() -> {
            try { if (trusted()) executor().execute(() -> process(serialized)); }
            catch (java.util.concurrent.RejectedExecutionException ignored) { /* JS timeout allows a later retry. */ }
            catch (Exception | LinkageError failure) { sendFailure(serialized, failure); }
        });
    }

    private void process(String serialized) {
        String id = null;
        JSONObject response = new JSONObject();
        try {
            JSONObject message = new JSONObject(serialized);
            id = message.getString("id");
            if (!id.matches("[a-fA-F0-9-]{36}")) return;
            response.put("id", id);
            String op = message.getString("op"); JSONObject args = message.getJSONObject("args");
            if (preferences == null) preferences = activity.getSharedPreferences("mira-host", Activity.MODE_PRIVATE);
            Object result;
            switch (op) {
                case "export-start":
                    if (exportPicking) throw new IOException("Finish the current backup save first.");
                    if (backup == null) backup = new BackupTransfer(activity.getCacheDir());
                    result = backup.start(args.getString("name"), args.getString("mime")); break;
                case "export-chunk":
                    if (backup == null) throw new IOException("Start a backup first.");
                    backup.chunk(args.getString("transfer"), args.getInt("sequence"), args.getString("data"));
                    result = new JSONObject().put("ok", true); break;
                case "export-cancel":
                    if (backup != null) backup.cancel(args.getString("transfer")); result = new JSONObject().put("ok", true); break;
                case "export-finish":
                    if (backup == null) throw new IOException("Start a backup first.");
                    BackupTransfer.Finished finished = backup.finish(args.getString("transfer")); exportPicking = true;
                    activity.runOnUiThread(() -> {
                        try {
                            if (!closed && trusted()) BackupSaveActivity.launch(activity, finished, this::exportFinished);
                            else { finished.file.delete(); exportPicking = false; }
                        } catch (RuntimeException | LinkageError failure) {
                            finished.file.delete(); exportPicking = false; sendFailure(serialized, failure);
                        }
                    });
                    result = new JSONObject().put("ok", true); break;
                case "request": result = NativeHttp.request(args, server); break;
                case "host-start":
                    ensureStarted(); preferences.edit().putBoolean("enabled", true).apply();
                    result = info(args); break;
                case "host-info":
                    String error = null;
                    if (preferences.getBoolean("enabled", false) && (server == null || !server.isRunning())) {
                        try { ensureStarted(); } catch (IOException e) { error = e.getMessage(); }
                    }
                    result = info(args).put("error", error == null ? JSONObject.NULL : error); break;
                case "host-stop":
                    preferences.edit().putBoolean("enabled", false).apply(); if (server != null) server.close();
                    result = info(args); break;
                default: throw new IOException("Unsupported Android operation.");
            }
            response.put("value", result);
        } catch (Exception | LinkageError e) {
            if (id == null) return;
            try {
                boolean timeout = e instanceof java.net.SocketTimeoutException;
                response.put("error", timeout ? "Android network connection timed out." :
                    e instanceof java.net.ConnectException || e instanceof java.net.NoRouteToHostException || e instanceof SecurityException ?
                    "Android could not open this network connection." : e instanceof IOException ? e.getMessage() : "Android could not complete this sync operation.");
                response.put("code", timeout ? "timeout" : "native_error");
            } catch (org.json.JSONException ignored) { return; }
        }
        send(response);
    }
    void exportFinished() { exportPicking = false; }

    private void sendFailure(String serialized, Throwable failure) {
        try {
            String id = new JSONObject(serialized).getString("id");
            if (!id.matches("[a-fA-F0-9-]{36}")) return;
            StartupLog.record(activity, "Native connection", failure);
            send(new JSONObject().put("id", id).put("error", "Native connection could not start. Your notes remain saved; reopen Settings & sync to retry.").put("code", "native_error"));
        } catch (Exception | LinkageError ignored) { /* Saving notes never depends on networking. */ }
    }
    private void send(JSONObject response) {
        String encoded = JSONObject.quote(response.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        activity.runOnUiThread(() -> {
            try { if (trusted()) web.evaluateJavascript("window.dispatchEvent(new CustomEvent('mira-native-result',{detail:JSON.parse(" + encoded + ")}));", null); }
            catch (RuntimeException | LinkageError failure) { StartupLog.record(activity, "Connection callback", failure); }
        });
    }

    private synchronized void ensureStarted() throws IOException {
        if (closed) throw new IOException("Reopen NoteMark to start phone hosting.");
        if (PhoneSyncServer.urls(47821).isEmpty()) throw new IOException("Connect this phone to Wi-Fi, then try Host from this phone again.");
        try { phoneServer().start(47821); }
        catch (java.net.BindException e) { throw new IOException("Phone sync port 47821 is already in use. Reopen NoteMark and try again."); }
    }
    private JSONObject info(JSONObject args) throws Exception {
        boolean running = server != null && server.isRunning();
        // Cold launch performs no network enumeration or server construction unless hosting was enabled.
        List<String> urls = running ? PhoneSyncServer.urls(server.getPort(), server.getScheme()) : java.util.Collections.emptyList();
        String id = args.optString("id", "");
        // Reading ownership never creates a TLS key or starts a listener during cold launch.
        PhoneSyncServer stored = server != null ? server : new PhoneSyncServer(new File(activity.getFilesDir(), "phone-sync-data"));
        boolean owns = !id.isEmpty() && stored.ownsNotebook(id, args.optString("token", ""));
        activity.runOnUiThread(() -> { try { if (!closed) web.setKeepScreenOn(running); } catch (RuntimeException ignored) {} });
        return new JSONObject().put("running", running).put("urls", new JSONArray(urls)).put("ownsNotebook", owns)
            .put("scheme", "https").put("fingerprint", identity == null ? "" : identity.fingerprint)
            .put("loopback", "http://127.0.0.1:" + (running ? server.getLoopbackPort() : 47821));
    }
    private boolean trusted() {
        if (closed || activity.isFinishing()) return false;
        Uri uri = Uri.parse(web.getUrl() == null ? "" : web.getUrl());
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost()) &&
            "/assets/index.html".equals(uri.getPath()) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }
    @Override public synchronized void close() {
        closed = true;
        if (workers != null) workers.shutdownNow();
        if (server != null) server.close();
        if (backup != null) backup.close();
    }
}
