package com.miranotes.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import android.view.Gravity;
import android.widget.Toast;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** Dependency-free host for the bundled UI, native sync transport and phone Wi-Fi server. */
public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/assets/index.html";
    private static final int OPEN_FILE = 4101;
    private static final int SAVE_FILE = 4102;
    private static final int MAX_EXPORT_BYTES = 16 * 1024 * 1024;
    private WebView web;
    private FrameLayout root;
    private AndroidBridge bridge;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] exportBytes;
    private boolean backPending;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(246, 248, 252));
        setContentView(root);
        // PhoneWindow.getInsetsController() dereferences its decor view. Install the
        // content first so Android 11+ has a decor view before configuring insets.
        try { configureInsets(root); }
        catch (RuntimeException | LinkageError failure) { StartupLog.record(this, "Window insets", failure); }
        TextView loading = new TextView(this);
        loading.setText("Opening your notebook…"); loading.setTextColor(Color.rgb(84, 103, 68));
        loading.setGravity(Gravity.CENTER); root.addView(loading, new FrameLayout.LayoutParams(-1, -1));
        // Give Android/OEM window setup a complete lifecycle turn before starting WebView.
        root.post(() -> openNotebook(savedInstanceState));
        if (Build.VERSION.SDK_INT >= 33) {
            try {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
            } catch (RuntimeException | LinkageError failure) { StartupLog.record(this, "Android back setup", failure); }
        }
    }

    private void openNotebook(Bundle savedInstanceState) {
        if (isFinishing() || isDestroyed()) return;
        try {
        destroyNotebook(); root.removeAllViews();
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(246, 248, 252));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // User-selected JSON files from the document picker.
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        // The configurable sync server may be on the user's HTTP LAN. Internet use should use HTTPS.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new ChromeClient());
        try {
            bridge = new AndroidBridge(this, web);
            web.addJavascriptInterface(bridge, "MiraAndroid");
        } catch (RuntimeException | LinkageError failure) {
            StartupLog.record(this, "Native bridge initialization", failure);
            if (bridge != null) bridge.close(); bridge = null;
            toast("Notebook ready. Native connection is unavailable; your saved notes are kept.");
        }
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> handleDownload(url, mime));
        boolean restored = false;
        if (savedInstanceState != null) {
            try { restored = web.restoreState(savedInstanceState) != null; }
            catch (RuntimeException failure) { StartupLog.record(this, "WebView session restore", failure); }
        }
        if (!restored) web.loadUrl(START);
        } catch (RuntimeException | LinkageError failure) {
            showStartupFailure("Android WebView startup", failure);
        }
    }

    private void destroyNotebook() {
        if (bridge != null) { try { bridge.close(); } catch (RuntimeException | LinkageError ignored) {} bridge = null; }
        WebView previous = web; web = null;
        if (previous != null) {
            try { previous.removeJavascriptInterface("MiraAndroid"); previous.stopLoading(); previous.destroy(); }
            catch (RuntimeException | LinkageError ignored) {}
        }
    }

    private void showStartupFailure(String stage, Throwable failure) {
        StartupLog.record(this, stage, failure); destroyNotebook(); root.removeAllViews();
        LinearLayout recovery = new LinearLayout(this); recovery.setOrientation(LinearLayout.VERTICAL);
        int pad = Math.round(24 * getResources().getDisplayMetrics().density); recovery.setPadding(pad, pad, pad, pad);
        recovery.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this); title.setText("Your notebook is safe on this device."); title.setTextSize(23); title.setTextColor(Color.rgb(41, 45, 40)); recovery.addView(title);
        TextView help = new TextView(this); help.setText("Android could not open the notes view. Retry, or update Android System WebView and reopen NoteMark. No notes or connection codes have been deleted."); help.setTextSize(16); help.setPadding(0, pad, 0, pad); recovery.addView(help);
        Button retry = new Button(this); retry.setText("Retry opening notes"); retry.setOnClickListener(v -> openNotebook(null)); recovery.addView(retry);
        Button webviewSettings = new Button(this); webviewSettings.setText("Android System WebView settings");
        webviewSettings.setOnClickListener(v -> {
            try {
                android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
                if (provider == null) throw new ActivityNotFoundException();
                startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + provider.packageName)));
            } catch (RuntimeException e) { openExternal(Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")); }
        }); recovery.addView(webviewSettings);
        Button details = new Button(this); details.setText("Copy startup error details");
        details.setOnClickListener(v -> {
            android.content.ClipboardManager clipboard = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (clipboard != null) clipboard.setPrimaryClip(android.content.ClipData.newPlainText("NoteMark startup", StartupLog.describe(this, stage, failure)));
            toast("Technical startup details copied. They do not include your notebook.");
        }); recovery.addView(details);
        root.addView(recovery, new FrameLayout.LayoutParams(-1, -1));
    }

    private void configureInsets(FrameLayout root) {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getDecorView().getWindowInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                    WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                    WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            try {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars() |
                    WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            } catch (RuntimeException | LinkageError failure) {
                try { view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); }
                catch (RuntimeException | LinkageError fallbackFailure) { StartupLog.record(this, "Applying window insets", fallbackFailure); }
            }
            return insets;
        });
        root.requestApplyInsets();
    }

    private static boolean isLocal(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme()) &&
            HOST.equalsIgnoreCase(uri.getHost()) && uri.getUserInfo() == null &&
            (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private final class LocalClient extends WebViewClient {
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view == web) showStartupFailure("WebView renderer", new IllegalStateException(
                detail.didCrash() ? "Android WebView renderer crashed" : "Android stopped the WebView renderer"));
            return true; // The Activity must survive a renderer exit so recovery stays available.
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!HOST.equalsIgnoreCase(uri.getHost())) return null; // Normal fetch to the configured sync API.
            if (!isLocal(uri)) return errorResponse(403, "Forbidden");
            if (!"GET".equals(request.getMethod()) && !"HEAD".equals(request.getMethod()))
                return errorResponse(405, "Method Not Allowed");
            String path = uri.getPath();
            if (path == null || !path.startsWith("/assets/") || path.indexOf('\\') >= 0 ||
                path.indexOf('\0') >= 0) return errorResponse(404, "Not Found");
            String relative = path.substring("/assets/".length());
            for (String segment : relative.split("/", -1)) {
                if (segment.equals("..") || segment.equals(".") || segment.isEmpty())
                    return errorResponse(404, "Not Found");
            }
            try {
                InputStream stream = getAssets().open("web/" + relative);
                Map<String, String> headers = new HashMap<>();
                headers.put("X-Content-Type-Options", "nosniff");
                headers.put("Cache-Control", "no-cache");
                headers.put("Content-Security-Policy", "default-src 'self' data: blob:; " +
                    "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
                    "img-src 'self' data: blob: https: http:; connect-src 'self' https: http:; " +
                    "object-src 'none'; frame-src 'none'; base-uri 'self'");
                if ("HEAD".equals(request.getMethod())) {
                    stream.close();
                    stream = new ByteArrayInputStream(new byte[0]);
                }
                return new WebResourceResponse(mimeFor(relative), "UTF-8", 200, "OK", headers, stream);
            } catch (IOException e) {
                return errorResponse(404, "Not Found");
            }
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isLocal(uri)) return false;
            if (request.isForMainFrame()) {
                if ("data".equals(uri.getScheme()) || "blob".equals(uri.getScheme()))
                    handleDownload(uri.toString(), "application/json");
                else openExternal(uri);
            }
            return true;
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler,
                android.net.http.SslError error) {
            handler.cancel();
        }
    }

    private final class ChromeClient extends WebChromeClient {
        @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }

        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"application/json", "application/zip", "application/x-zip-compressed", "text/plain"});
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try { startActivityForResult(pick, OPEN_FILE); }
            catch (ActivityNotFoundException e) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
                toast("No file picker is available on this phone.");
            }
            return true;
        }
    }

    private static String mimeFor(String path) {
        String lower = path.toLowerCase(java.util.Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static WebResourceResponse errorResponse(int code, String reason) {
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Content-Type-Options", "nosniff");
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, headers,
            new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException e) { toast("No browser is available to open this link."); }
    }

    private void handleDownload(String url, String mime) {
        if (!isLocal(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) return;
        if (url.startsWith("data:")) {
            try {
                int comma = url.indexOf(',');
                if (comma < 0 || comma > 200 || url.length() > MAX_EXPORT_BYTES * 4)
                    throw new IOException("Invalid export");
                String metadata = url.substring(5, comma).toLowerCase(java.util.Locale.ROOT);
                if (!metadata.startsWith("application/json") && !metadata.startsWith("text/json") &&
                    !metadata.startsWith("text/plain")) throw new IOException("Unsupported export");
                byte[] bytes = metadata.contains(";base64") ? Base64.decode(url.substring(comma + 1), Base64.DEFAULT) :
                    URLDecoder.decode(url.substring(comma + 1).replace("+", "%2B"), "UTF-8")
                        .getBytes(StandardCharsets.UTF_8);
                beginExport(bytes);
            } catch (Exception e) { toast("Unable to save this export. Please try again."); }
        } else if (url.startsWith("blob:https://" + HOST + "/")) {
            // This reads a local app-created blob.
            String script = "(function(){try{var x=new XMLHttpRequest();x.open('GET'," +
                JSONObject.quote(url) + ",false);x.send();return x.responseText;}catch(e){return null;}})()";
            web.evaluateJavascript(script, value -> {
                try {
                    Object decoded = new JSONTokener(value).nextValue();
                    if (!(decoded instanceof String)) throw new IOException("Blob unavailable");
                    beginExport(((String) decoded).getBytes(StandardCharsets.UTF_8));
                } catch (Exception e) { toast("Unable to save this export. Please try again."); }
            });
        } else { openExternal(Uri.parse(url)); }
    }

    private void beginExport(byte[] bytes) throws IOException {
        if (bytes.length > MAX_EXPORT_BYTES) throw new IOException("Export is too large");
        // Preserve the original bytes, including a recovery export of damaged local data.
        if (exportBytes != null) { toast("Finish the current save first."); return; }
        exportBytes = bytes;
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        save.addCategory(Intent.CATEGORY_OPENABLE);
        save.setType("application/json");
        save.putExtra(Intent.EXTRA_TITLE, "NoteMark-recovery-" +
            new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.ROOT).format(new java.util.Date()) + ".json");
        try { startActivityForResult(save, SAVE_FILE); }
        catch (ActivityNotFoundException e) {
            exportBytes = null;
            toast("No document save picker is available on this phone.");
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == OPEN_FILE && fileCallback != null) {
            Uri[] selected = result == RESULT_OK ? WebChromeClient.FileChooserParams.parseResult(result, data) : null;
            fileCallback.onReceiveValue(selected);
            fileCallback = null;
        } else if (request == SAVE_FILE) {
            byte[] bytes = exportBytes;
            exportBytes = null;
            if (result == RESULT_OK && data != null && data.getData() != null && bytes != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData(), "wt")) {
                    if (out == null) throw new FileNotFoundException();
                    out.write(bytes);
                    toast("Backup saved.");
                } catch (IOException e) { toast("The backup could not be saved."); }
            }
        }
    }

    @Override public void onBackPressed() { handleBack(); }

    private void handleBack() {
        if (web == null) { finish(); return; }
        if (backPending) return;
        backPending = true;
        web.evaluateJavascript("(function(){var e=new CustomEvent('mira-back',{cancelable:true});" +
            "window.dispatchEvent(e);return e.defaultPrevented;})()", handled -> {
            backPending = false;
            if ("true".equals(handled)) return;
            if (web.canGoBack()) web.goBack();
            else new AlertDialog.Builder(this).setTitle("Close NoteMark?")
                .setMessage("You can reopen NoteMark to continue writing.")
                .setNegativeButton("Keep writing", null)
                .setPositiveButton("Close", (dialog, which) -> finish()).show();
        });
    }

    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private void flushNotebook() {
        try { if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('mira-save'));", null); }
        catch (RuntimeException | LinkageError failure) { StartupLog.record(this, "Saving notebook fields", failure); }
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        flushNotebook();
        try { if (web != null) web.saveState(state); }
        catch (RuntimeException failure) { StartupLog.record(this, "Saving WebView session", failure); }
        super.onSaveInstanceState(state);
    }
    @Override protected void onPause() {
        flushNotebook();
        super.onPause(); try { if (web != null) web.onPause(); }
        catch (RuntimeException failure) { StartupLog.record(this, "Pausing WebView", failure); }
    }
    @Override protected void onResume() {
        super.onResume(); try { if (web != null) web.onResume(); }
        catch (RuntimeException | LinkageError failure) { showStartupFailure("Resuming WebView", failure); }
    }
    @Override protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        destroyNotebook();
        super.onDestroy();
    }
}
