package com.miranotes.app;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import java.util.Locale;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** JSON-only Mira transport. TLS verification stays enabled; redirects are rejected. */
final class NativeHttp {
    static final int MAX_BODY = 2 * 1024 * 1024;
    static final int MAX_RESPONSE = 70 * 1024 * 1024;
    private static final String ID = "[0-9a-fA-F-]{36}";
    private static final Pattern API = Pattern.compile("^/(?:[A-Za-z0-9_-]+/)*api/(health|vaults(?:/" + ID + "/notes(?:/" + ID + ")?)?)$");

    static URI validate(String address, String method) throws Exception {
        URI uri = new URI(address);
        String host = uri.getHost(), scheme = uri.getScheme();
        if (host == null || uri.getUserInfo() != null || uri.getRawQuery() != null ||
                uri.getRawFragment() != null || !API.matcher(uri.getRawPath()).matches() ||
                (!"https".equals(scheme) && !("http".equals(scheme) && privateHost(host))))
            throw new IOException("Use a NoteMark sync API on HTTPS or your local Wi-Fi.");
        String path = uri.getPath();
        boolean allowed = "GET".equals(method) && (path.endsWith("/api/health") || path.endsWith("/notes")) ||
            "POST".equals(method) && path.endsWith("/api/vaults") ||
            "PUT".equals(method) && path.matches(".*/notes/" + ID);
        if (!allowed) throw new IOException("Unsupported NoteMark sync operation.");
        return uri;
    }

    static boolean privateHost(String host) {
        if ("localhost".equalsIgnoreCase(host) || "[::1]".equals(host) || "::1".equals(host)) return true;
        if (!host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
        String[] parts = host.split("\\.");
        int[] n = new int[4];
        try { for (int i = 0; i < 4; i++) { n[i] = Integer.parseInt(parts[i]); if (n[i] > 255) return false; } }
        catch (NumberFormatException e) { return false; }
        return n[0] == 127 || n[0] == 10 || n[0] == 192 && n[1] == 168 || n[0] == 172 && n[1] >= 16 && n[1] <= 31;
    }

    static JSONObject request(JSONObject args, PhoneSyncServer local) throws Exception {
        String method = args.getString("method"), token = args.optString("token", ""), body = args.optString("body", "");
        URI uri = validate(args.getString("url"), method);
        if (args.has("fingerprint") && !(args.get("fingerprint") instanceof String))
            throw new IOException("Invalid phone certificate fingerprint.");
        String fingerprint = args.optString("fingerprint", "");
        if (!fingerprint.isEmpty() && (!fingerprint.matches("[0-9a-fA-F]{64}") ||
                !"https".equals(uri.getScheme()) || !privateHost(uri.getHost())))
            throw new IOException("A phone certificate fingerprint requires local HTTPS.");
        if (!token.isEmpty() && !token.matches("[A-Za-z0-9_-]{43}")) throw new IOException("Invalid connection token.");
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BODY) throw new IOException("This note is too large to sync.");
        if ("GET".equals(method) && bytes.length != 0) throw new IOException("Invalid sync request.");
        // A phone's own notebook stays reachable through loopback, even after its Wi-Fi IP changes.
        String[] path = uri.getPath().split("/");
        boolean ownHealth = "/api/health".equals(uri.getPath()) && args.optString("notebook", "").matches(ID) && local != null && local.ownsNotebook(args.optString("notebook"), token);
        if (local != null && local.isRunning() && (ownHealth || path.length >= 5 && "api".equals(path[1]) &&
                "vaults".equals(path[2]) && local.ownsNotebook(path[3], token)))
            uri = new URI("http", null, "127.0.0.1", local.getLoopbackPort(), uri.getPath(), null, null);
        HttpURLConnection connection = (HttpURLConnection) new URL(uri.toASCIIString()).openConnection();
        try {
            if (!fingerprint.isEmpty() && connection instanceof HttpsURLConnection) {
                HttpsURLConnection secure = (HttpsURLConnection) connection;
                secure.setSSLSocketFactory(pinnedContext(fingerprint).getSocketFactory());
                // Exact certificate pinning identifies the local phone even when its IP changes.
                secure.setHostnameVerifier((host, session) -> true);
            }
            connection.setRequestMethod(method);
            connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
            connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (!"GET".equals(method)) {
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new IOException("Use the final sync server address; redirects are not accepted.");
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) throw new IOException("The address did not return a NoteMark response.");
            byte[] response;
            try (InputStream in = stream) { response = readBounded(in, MAX_RESPONSE); }
            JSONObject data;
            try { data = new JSONObject(new String(response, StandardCharsets.UTF_8)); }
            catch (org.json.JSONException e) { throw new IOException("This address is not a NoteMark sync server."); }
            return new JSONObject().put("status", status).put("data", data);
        } finally { connection.disconnect(); }
    }

    static SSLContext pinnedContext(String fingerprint) throws Exception {
        if (fingerprint == null || !fingerprint.matches("[0-9a-fA-F]{64}"))
            throw new IOException("Invalid phone certificate fingerprint.");
        final String expected = fingerprint.toLowerCase(Locale.ROOT);
        X509TrustManager manager = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Client certificates are not used for notebook sync.");
            }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain != null && chain.length > 0) try {
                    if (MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                            PhoneIdentity.fingerprint(chain[0]).getBytes(StandardCharsets.US_ASCII))) {
                        chain[0].checkValidity(); return;
                    }
                } catch (CertificateException failure) { throw failure; }
                catch (Exception failure) { throw new CertificateException("The phone certificate could not be verified.", failure); }
                throw new CertificateException("The phone certificate changed. Check the private connection code again.");
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] { manager }, new SecureRandom()); return context;
    }

    static byte[] readBounded(InputStream in, int maximum) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192]; int count;
        while ((count = in.read(buffer)) != -1) {
            if (out.size() + count > maximum) throw new IOException("Sync response is too large.");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }
}
