package com.miranotes.app;

import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;

/** Protocol 1 encrypted storage for the reverse (PC -> phone) Wi-Fi connection. */
final class PhoneSyncServer implements AutoCloseable {
    private static final String ID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
    private static final int MAX_VAULT = 64 * 1024 * 1024;
    private static final long MAX_TOTAL = 128L * 1024 * 1024;
    private final File directory;
    private final SSLContext tls;
    private final Set<Socket> sockets = Collections.synchronizedSet(new HashSet<>());
    private final Map<String, long[]> failures = new HashMap<>();
    private ServerSocket listener;
    private ServerSocket loopbackListener;
    private ThreadPoolExecutor workers;
    private volatile boolean running;
    private int port;
    private int loopbackPort;

    PhoneSyncServer(File directory) { this(directory, null); }
    PhoneSyncServer(File directory, SSLContext tls) { this.directory = directory; this.tls = tls; }
    synchronized void start(int desiredPort) throws IOException {
        if (running) return;
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Phone sync storage is unavailable.");
        ServerSocket next = tls == null ? new ServerSocket() : tls.getServerSocketFactory().createServerSocket();
        ServerSocket local = null;
        try {
            if (next instanceof SSLServerSocket) {
                SSLServerSocket secure = (SSLServerSocket) next;
                List<String> protocols = new ArrayList<>();
                for (String protocol : secure.getSupportedProtocols())
                    if ("TLSv1.2".equals(protocol) || "TLSv1.3".equals(protocol)) protocols.add(protocol);
                if (protocols.isEmpty()) throw new IOException("This Android TLS provider cannot host secure sync.");
                secure.setEnabledProtocols(protocols.toArray(new String[0])); secure.setNeedClientAuth(false);
                local = new ServerSocket(); local.setReuseAddress(true);
                local.bind(new InetSocketAddress("127.0.0.1", 0), 8);
            }
            next.setReuseAddress(true); next.bind(new InetSocketAddress("0.0.0.0", desiredPort), 16);
        } catch (IOException | RuntimeException failure) {
            try { next.close(); } catch (IOException ignored) {}
            if (local != null) try { local.close(); } catch (IOException ignored) {}
            throw failure;
        }
        listener = next; loopbackListener = local; port = next.getLocalPort();
        loopbackPort = local == null ? port : local.getLocalPort(); running = true;
        workers = new ThreadPoolExecutor(2, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16), task -> {
            Thread thread = new Thread(task, "Mira-phone-sync"); thread.setDaemon(true); return thread;
        });
        Thread accept = new Thread(() -> acceptLoop(next), "Mira-phone-listener");
        accept.setDaemon(true); accept.start();
        if (local != null) {
            final ServerSocket localListener = local;
            Thread loopback = new Thread(() -> acceptLoop(localListener), "Mira-phone-loopback");
            loopback.setDaemon(true); loopback.start();
        }
    }
    boolean isRunning() { return running; }
    int getPort() { return port; }
    int getLoopbackPort() { return loopbackPort; }
    String getScheme() { return tls == null ? "http" : "https"; }

    private void acceptLoop(ServerSocket server) {
        while (!server.isClosed()) {
            try {
                Socket client = server.accept();
                InetAddress peer = client.getInetAddress();
                if (!peer.isLoopbackAddress() && !peer.isSiteLocalAddress()) { client.close(); continue; }
                client.setSoTimeout(15000); sockets.add(client);
                try { workers.execute(() -> serve(client)); }
                catch (java.util.concurrent.RejectedExecutionException e) { sockets.remove(client); client.close(); }
            } catch (IOException e) { if (server.isClosed()) return; }
        }
    }

    private void serve(Socket client) {
        try (Socket socket = client) {
            InputStream in = new BufferedInputStream(socket.getInputStream());
            Map<String, String> headers = new HashMap<>();
            int status; JSONObject result;
            try {
                String first = line(in, 4096);
                String[] request = first.split(" ", -1);
                if (request.length != 3 || !request[2].matches("HTTP/1\\.[01]")) throw new Failure(400, "invalid_request");
                int headerSize = first.length();
                for (;;) {
                    String header = line(in, 8192); headerSize += header.length() + 2;
                    if (headerSize > 16384) throw new Failure(431, "headers_too_large");
                    if (header.isEmpty()) break;
                    int colon = header.indexOf(':');
                    if (colon <= 0) throw new Failure(400, "invalid_request");
                    String key = header.substring(0, colon).toLowerCase(Locale.ROOT);
                    if (!key.matches("[a-z0-9-]+") || headers.containsKey(key)) throw new Failure(400, "invalid_request");
                    headers.put(key, header.substring(colon + 1).trim());
                }
                if (headers.containsKey("transfer-encoding")) throw new Failure(400, "content_length_required");
                String method = request[0], path = request[1];
                if (!path.startsWith("/api/") || path.indexOf('?') >= 0 || path.indexOf('%') >= 0)
                    throw new Failure(404, "not_found");
                int length;
                try { length = Integer.parseInt(headers.getOrDefault("content-length", "0")); }
                catch (NumberFormatException e) { throw new Failure(400, "invalid_length"); }
                if (length < 0 || length > NativeHttp.MAX_BODY) throw new Failure(413, "body_too_large");
                JSONObject body = null;
                if ("POST".equals(method) || "PUT".equals(method)) {
                    if (!headers.getOrDefault("content-type", "").split(";", 2)[0].trim().equalsIgnoreCase("application/json") ||
                            !headers.getOrDefault("content-encoding", "identity").equals("identity"))
                        throw new Failure(415, "json_required");
                    byte[] bytes = new byte[length]; int offset = 0;
                    while (offset < length) { int n = in.read(bytes, offset, length - offset); if (n == -1) throw new Failure(400, "invalid_request"); offset += n; }
                    try { body = new JSONObject(new String(bytes, StandardCharsets.UTF_8)); }
                    catch (org.json.JSONException e) { throw new Failure(400, "invalid_json"); }
                }
                Reply reply = route(method, path, headers.get("authorization"), body,
                    socket.getInetAddress().getHostAddress(), socket.getInetAddress().isLoopbackAddress());
                status = reply.status; result = reply.data;
            } catch (Failure e) { status = e.status; result = e.data; }
            catch (Exception e) { status = 503; result = json("error", "phone_storage_unavailable"); }
            byte[] bytes = status == 204 ? new byte[0] : result.toString().getBytes(StandardCharsets.UTF_8);
            String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\nContent-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: " + bytes.length + "\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" +
                "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Max-Age: 600\r\n" +
                ("true".equals(headers.get("access-control-request-private-network")) ?
                    "Access-Control-Allow-Private-Network: true\r\nVary: Access-Control-Request-Private-Network\r\n" : "") + "\r\n";
            OutputStream out = socket.getOutputStream(); out.write(head.getBytes(StandardCharsets.US_ASCII)); out.write(bytes); out.flush();
        } catch (IOException ignored) { /* Disconnected clients retry using revisions. */ }
        finally { sockets.remove(client); }
    }

    private synchronized Reply route(String method, String path, String authorization, JSONObject body,
            String peer, boolean loopback) throws Exception {
        if ("OPTIONS".equals(method)) return new Reply(204, new JSONObject());
        if ("GET".equals(method) && "/api/health".equals(path))
            return new Reply(200, new JSONObject().put("ok", true).put("protocol", 1).put("capabilities", new JSONObject().put("permanentDelete", true)));
        if ("POST".equals(method) && "/api/vaults".equals(path)) {
            // Only the phone UI creates notebooks. Other devices join with the private code.
            if (!loopback) throw new Failure(403, "create_on_phone");
            shape(body, "id", "token");
            String id = id(body.get("id")), token = base64(body.get("token"), 32, 32, "token");
            File file = file(id);
            if (file.exists()) throw new Failure(409, "vault_exists");
            File[] vaults = directory.listFiles((dir, name) -> name.matches(ID + "\\.json"));
            if (vaults == null || vaults.length >= 8) throw new Failure(507, "phone_notebook_limit");
            persist(file, new JSONObject().put("schema", 1).put("id", id).put("tokenHash", hash(token)).put("notes", new JSONObject()));
            return new Reply(201, json("id", id));
        }
        String[] pieces = path.split("/", -1);
        if (pieces.length < 5 || pieces.length > 6 || !"api".equals(pieces[1]) ||
                !"vaults".equals(pieces[2]) || !"notes".equals(pieces[4])) throw new Failure(404, "not_found");
        String vaultId = id(pieces[3]);
        checkRate(peer);
        JSONObject vault = load(vaultId);
        String token = authorization != null && authorization.startsWith("Bearer ") ? authorization.substring(7) : "";
        if (vault == null || !authorized(vault, token)) { recordFailure(peer); throw new Failure(401, "unauthorized"); }
        JSONObject notes = vault.getJSONObject("notes");
        if ("GET".equals(method) && pieces.length == 5) {
            JSONArray records = new JSONArray(); Iterator<String> keys = notes.keys();
            while (keys.hasNext()) records.put(notes.getJSONObject(keys.next()));
            return new Reply(200, json("notes", records));
        }
        if ("PUT".equals(method) && pieces.length == 6) {
            String noteId = id(pieces[5]);
            shape(body, "baseRevision", "iv", "ciphertext", "deleted");
            Object revision = body.get("baseRevision");
            if (!(revision instanceof Number) || ((Number) revision).doubleValue() != ((Number) revision).longValue() ||
                    ((Number) revision).longValue() < 0 || ((Number) revision).longValue() >= 9007199254740991L ||
                    !(body.get("deleted") instanceof Boolean)) throw new Failure(400, "invalid_record");
            String iv = base64(body.get("iv"), 12, 12, "iv");
            String ciphertext = base64(body.get("ciphertext"), 16, 1024 * 1024 + 16, "ciphertext");
            JSONObject current = notes.optJSONObject(noteId);
            if (current != null && current.optBoolean("deleted", false))
                return new Reply(409, new JSONObject().put("error", "conflict").put("current", current));
            long currentRevision = current == null ? 0 : current.getLong("revision");
            if (((Number) revision).longValue() != currentRevision)
                return new Reply(409, new JSONObject().put("error", "conflict").put("current", current == null ? JSONObject.NULL : current));
            if (current == null && notes.length() >= 5000) throw new Failure(507, "note_limit");
            SimpleDateFormat date = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
            date.setTimeZone(TimeZone.getTimeZone("UTC"));
            JSONObject record = new JSONObject().put("id", noteId).put("revision", currentRevision + 1).put("iv", iv)
                .put("ciphertext", ciphertext).put("deleted", body.getBoolean("deleted")).put("updatedAt", date.format(new java.util.Date()));
            notes.put(noteId, record); persist(file(vaultId), vault);
            return new Reply(200, record);
        }
        throw new Failure(405, "method_not_allowed");
    }

    synchronized boolean ownsNotebook(String id, String token) {
        if (id == null || !id.matches(ID)) return false;
        try { JSONObject vault = load(id.toLowerCase(Locale.ROOT)); return vault != null && authorized(vault, token); }
        catch (Exception e) { return false; }
    }
    private boolean authorized(JSONObject vault, String token) throws Exception {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) return false;
        return MessageDigest.isEqual(hash(token).getBytes(StandardCharsets.US_ASCII),
            vault.getString("tokenHash").getBytes(StandardCharsets.US_ASCII));
    }
    private File file(String id) { return new File(directory, id + ".json"); }
    private JSONObject load(String id) throws Exception {
        File file = file(id); if (!file.exists()) return null;
        if (file.length() > MAX_VAULT) throw new IOException("Vault too large");
        JSONObject vault = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        if (vault.getInt("schema") != 1 || !id.equals(vault.getString("id"))) throw new IOException("Invalid storage");
        return vault;
    }
    private void persist(File target, JSONObject vault) throws Exception {
        byte[] bytes = vault.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_VAULT) throw new Failure(507, "vault_size_limit");
        long total = bytes.length; File[] files = directory.listFiles();
        if (files != null) for (File existing : files) if (!existing.equals(target) && existing.getName().endsWith(".json")) total += existing.length();
        if (total > MAX_TOTAL) throw new Failure(507, "phone_storage_limit");
        File temporary = new File(directory, target.getName() + "." + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(bytes); out.getFD().sync(); }
            try { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (java.nio.file.AtomicMoveNotSupportedException e) { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(temporary.toPath()); }
    }
    private static String id(Object value) throws Failure {
        if (!(value instanceof String) || !((String) value).matches(ID)) throw new Failure(400, "invalid_id");
        return ((String) value).toLowerCase(Locale.ROOT);
    }
    private static String base64(Object value, int minimum, int maximum, String field) throws Failure {
        if (!(value instanceof String)) throw new Failure(400, "invalid_" + field);
        String text = (String) value;
        if (text.length() > (maximum * 4L + 2) / 3 || !text.matches("[A-Za-z0-9_-]+")) throw new Failure(400, "invalid_" + field);
        try {
            byte[] bytes = Base64.decode(text, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            if (bytes.length < minimum || bytes.length > maximum || !encode(bytes).equals(text)) throw new IllegalArgumentException();
        } catch (IllegalArgumentException e) { throw new Failure(400, "invalid_" + field); }
        return text;
    }
    private static String encode(byte[] bytes) { return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }
    private static String hash(String token) throws Exception { return encode(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8))); }
    private static void shape(JSONObject body, String... keys) throws Failure {
        if (body == null || body.length() != keys.length) throw new Failure(400, "invalid_fields");
        for (String key : keys) if (!body.has(key)) throw new Failure(400, "invalid_fields");
    }
    private void checkRate(String peer) throws Failure {
        long now = System.currentTimeMillis();
        failures.entrySet().removeIf(entry -> entry.getValue()[1] < now);
        long[] entry = failures.get(peer);
        if (failures.size() >= 1024 && entry == null || entry != null && entry[0] >= 120) throw new Failure(429, "rate_limited");
    }
    private void recordFailure(String peer) {
        long[] entry = failures.get(peer);
        if (entry == null) failures.put(peer, new long[] { 1, System.currentTimeMillis() + 60000 }); else entry[0]++;
    }
    private static String line(InputStream in, int maximum) throws IOException, Failure {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (;;) {
            int c = in.read(); if (c < 0) throw new IOException("Disconnected");
            if (c == '\n') {
                byte[] value = bytes.toByteArray();
                if (value.length == 0 || value[value.length - 1] != '\r') throw new Failure(400, "invalid_request");
                return new String(value, 0, value.length - 1, StandardCharsets.US_ASCII);
            }
            if (bytes.size() >= maximum || c == 0 || c > 127) throw new Failure(400, "invalid_request");
            bytes.write(c);
        }
    }
    static List<String> urls(int port) throws IOException {
        return urls(port, "http");
    }
    static List<String> urls(int port, String scheme) throws IOException {
        if (!"http".equals(scheme) && !"https".equals(scheme)) throw new IOException("Invalid sync protocol.");
        List<String> wifi = new ArrayList<>(), others = new ArrayList<>();
        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        if (interfaces != null) while (interfaces.hasMoreElements()) {
            NetworkInterface network = interfaces.nextElement();
            if (!network.isUp() || network.isLoopback()) continue;
            Enumeration<InetAddress> addresses = network.getInetAddresses();
            while (addresses.hasMoreElements()) {
                InetAddress address = addresses.nextElement();
                if (address instanceof Inet4Address && address.isSiteLocalAddress()) {
                    String url = scheme + "://" + address.getHostAddress() + ":" + port;
                    (network.getName().startsWith("wlan") || network.getName().startsWith("ap") ? wifi : others).add(url);
                }
            }
        }
        wifi.addAll(others); return wifi;
    }
    @Override public synchronized void close() {
        running = false;
        if (listener != null) try { listener.close(); } catch (IOException ignored) {}
        if (loopbackListener != null) try { loopbackListener.close(); } catch (IOException ignored) {}
        if (workers != null) workers.shutdownNow();
        synchronized (sockets) { for (Socket socket : sockets) try { socket.close(); } catch (IOException ignored) {} sockets.clear(); }
    }
    private static JSONObject json(String key, Object value) {
        try { return new JSONObject().put(key, value); } catch (org.json.JSONException e) { throw new IllegalArgumentException(e); }
    }
    private static String reason(int status) {
        if (status == 200) return "OK"; if (status == 201) return "Created"; if (status == 204) return "No Content";
        if (status == 401) return "Unauthorized"; if (status == 409) return "Conflict";
        return status >= 500 ? "Server Error" : "Request Error";
    }
    private static final class Reply { final int status; final JSONObject data; Reply(int status, JSONObject data) { this.status = status; this.data = data; } }
    private static final class Failure extends Exception {
        final int status; final JSONObject data;
        Failure(int status, String error) { this.status = status; this.data = json("error", error); }
    }
}
