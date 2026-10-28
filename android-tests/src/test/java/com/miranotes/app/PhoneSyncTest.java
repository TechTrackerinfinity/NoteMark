package com.miranotes.app;

import static org.junit.Assert.*;
import android.util.Base64;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
public class PhoneSyncTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final String TOKEN = b64(32, 7);
    private static String b64(int length, int value) {
        byte[] bytes = new byte[length]; Arrays.fill(bytes, (byte) value);
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
    private JSONObject request(String server, String path, String method, String token, JSONObject body, PhoneSyncServer local) throws Exception {
        return NativeHttp.request(new JSONObject().put("url", server + path).put("method", method).put("token", token)
            .put("body", body == null ? "" : body.toString()), local);
    }
    private String create(PhoneSyncServer server) throws Exception {
        String id = UUID.randomUUID().toString();
        JSONObject result = request("http://127.0.0.1:" + server.getPort(), "/api/vaults", "POST", "",
            new JSONObject().put("id", id).put("token", TOKEN), null);
        assertEquals(201, result.getInt("status")); return id;
    }

    @Test public void windowsJavaScriptAndAndroidNativeTransportSyncThroughPhoneAndRestart() throws Exception {
        File data = temporary.newFolder("phone-data"), fixture = new File(temporary.getRoot(), "synthetic-client.json");
        PhoneSyncServer server = new PhoneSyncServer(data); server.start(0);
        int port = server.getPort(); String address = "http://127.0.0.1:" + port;
        try {
            nodeClient(address, fixture, "create");
            JSONObject config = new JSONObject(Files.readString(fixture.toPath())).getJSONObject("config");
            JSONObject result = request(address, "/api/vaults/" + config.getString("id") + "/notes", "GET", config.getString("token"), null, server);
            assertEquals(200, result.getInt("status")); assertEquals(2, result.getJSONObject("data").getJSONArray("notes").length());
            assertTrue(server.ownsNotebook(config.getString("id"), config.getString("token")));
            String stored = Files.readString(data.listFiles()[0].toPath());
            assertFalse(stored.contains(config.getString("token"))); assertFalse(stored.contains(config.getString("key")));
            assertFalse(stored.contains("Phone offline edit")); assertFalse(stored.contains("Windows offline edit"));
            server.close(); server = new PhoneSyncServer(data); server.start(port);
            nodeClient(address, fixture, "restart");
        } finally { server.close(); }
    }

    private void nodeClient(String address, File fixture, String phase) throws Exception {
        File script = new File("../test/phone-host-client.mjs").getCanonicalFile();
        Process process = new ProcessBuilder("node", script.toString(), address, fixture.toString(), phase).redirectErrorStream(true).start();
        boolean finished = process.waitFor(30, TimeUnit.SECONDS);
        if (!finished) { process.destroyForcibly(); fail("JavaScript phone-host test timed out"); }
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(output, 0, process.exitValue()); assertTrue(output, output.contains("\"ok\":true"));
        System.out.println("Java/JS phone-host interoperability: " + output.trim());
    }

    @Test public void nativeTransportUsesLoopbackForOwnNotebookAfterPhoneAddressChanges() throws Exception {
        try (PhoneSyncServer server = new PhoneSyncServer(temporary.newFolder())) {
            server.start(0); String id = create(server);
            JSONObject result = request("http://192.168.77.254:47821", "/api/vaults/" + id + "/notes", "GET", TOKEN, null, server);
            assertEquals(200, result.getInt("status"));
            assertEquals(0, result.getJSONObject("data").getJSONArray("notes").length());
            JSONObject health = NativeHttp.request(new JSONObject().put("url", "http://192.168.77.254:47821/api/health").put("method", "GET").put("token", TOKEN).put("notebook", id), server);
            assertTrue(health.getJSONObject("data").getJSONObject("capabilities").getBoolean("permanentDelete"));
        }
    }

    @Test public void concurrentUpdatesHaveOneWinnerAndStaleRevisionCannotOverwriteIt() throws Exception {
        try (PhoneSyncServer server = new PhoneSyncServer(temporary.newFolder())) {
            server.start(0); String vault = create(server), note = UUID.randomUUID().toString(), address = "http://127.0.0.1:" + server.getPort();
            JSONObject body = new JSONObject().put("baseRevision", 0).put("iv", b64(12, 1)).put("ciphertext", b64(32, 2)).put("deleted", false);
            ExecutorService clients = Executors.newFixedThreadPool(2);
            try {
                Callable<Integer> write = () -> request(address, "/api/vaults/" + vault + "/notes/" + note, "PUT", TOKEN, body, null).getInt("status");
                Future<Integer> first = clients.submit(write), second = clients.submit(write);
                assertEquals(609, first.get(10, TimeUnit.SECONDS) + second.get(10, TimeUnit.SECONDS));
                JSONObject stale = request(address, "/api/vaults/" + vault + "/notes/" + note, "PUT", TOKEN, body, null);
                assertEquals(409, stale.getInt("status")); assertEquals(1, stale.getJSONObject("data").getJSONObject("current").getInt("revision"));
            } finally { clients.shutdownNow(); }
        }
    }

    @Test public void phoneHostAllowsBrowserPreflightAndRejectsBadCredentialsAndPlaintextFields() throws Exception {
        File data = temporary.newFolder();
        try (PhoneSyncServer server = new PhoneSyncServer(data)) {
            server.start(0); String vault = create(server), address = "http://127.0.0.1:" + server.getPort();
            HttpURLConnection preflight = (HttpURLConnection) new URL(address + "/api/vaults/" + vault + "/notes").openConnection();
            try {
                preflight.setRequestMethod("OPTIONS"); preflight.setRequestProperty("Access-Control-Request-Private-Network", "true");
                assertEquals(204, preflight.getResponseCode()); assertEquals("true", preflight.getHeaderField("Access-Control-Allow-Private-Network"));
                assertEquals("*", preflight.getHeaderField("Access-Control-Allow-Origin"));
            } finally { preflight.disconnect(); }
            assertEquals(401, request(address, "/api/vaults/" + vault + "/notes", "GET", b64(32, 9), null, null).getInt("status"));
            JSONObject plaintext = new JSONObject().put("title", "must not be stored");
            assertEquals(400, request(address, "/api/vaults/" + vault + "/notes/" + UUID.randomUUID(), "PUT", TOKEN, plaintext, null).getInt("status"));
            assertFalse(Files.readString(new File(data, vault + ".json").toPath()).contains("must not be stored"));
        }
    }

    @Test public void nativeNetworkSurfaceIsLimitedAndRedirectsAreNotFollowed() throws Exception {
        for (String bad : new String[] {"http://example.com/api/health", "file:///api/health", "http://127.0.0.1/private", "http://127.0.0.1/api/health?x=1", "https://u:p@example.com/api/health", "http://127.0.0.1/api/%2e%2e/health"}) {
            try { NativeHttp.validate(bad, "GET"); fail("Accepted " + bad); } catch (java.io.IOException | java.net.URISyntaxException expected) {}
        }
        assertNotNull(NativeHttp.validate("https://notes.example.com/sync/api/health", "GET"));
        try (ServerSocket redirect = new ServerSocket(0)) {
            Thread responder = new Thread(() -> {
                try (Socket socket = redirect.accept()) {
                    InputStream in = socket.getInputStream(); int sequence = 0, c;
                    while ((c = in.read()) != -1) { sequence = c == "\r\n\r\n".charAt(sequence) ? sequence + 1 : 0; if (sequence == 4) break; }
                    socket.getOutputStream().write("HTTP/1.1 302 Found\r\nLocation: http://example.com/api/health\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                } catch (Exception ignored) {}
            }); responder.setDaemon(true); responder.start();
            try { request("http://127.0.0.1:" + redirect.getLocalPort(), "/api/health", "GET", "", null, null); fail("Followed a redirect"); }
            catch (java.io.IOException expected) { assertTrue(expected.getMessage().contains("redirects")); }
        }
    }

    @Test public void closingTheActivityServerReleasesItsPort() throws Exception {
        PhoneSyncServer server = new PhoneSyncServer(temporary.newFolder()); server.start(0); int port = server.getPort();
        assertEquals(200, request("http://127.0.0.1:" + port, "/api/health", "GET", "", null, null).getInt("status"));
        server.close(); assertFalse(server.isRunning());
        try (ServerSocket replacement = new ServerSocket(port)) { assertEquals(port, replacement.getLocalPort()); }
    }

    @Test public void permanentDeletionIsTerminalEvenWithCurrentRevisionAfterRestart() throws Exception {
        File data = temporary.newFolder(); PhoneSyncServer server = new PhoneSyncServer(data); server.start(0);
        try {
            String address = "http://127.0.0.1:" + server.getPort(), vault = create(server), path = "/api/vaults/" + vault + "/notes/" + UUID.randomUUID();
            assertTrue(request(address,"/api/health","GET","",null,null).getJSONObject("data").getJSONObject("capabilities").getBoolean("permanentDelete"));
            JSONObject body = new JSONObject().put("baseRevision",0).put("iv",b64(12,1)).put("ciphertext",b64(32,2)).put("deleted",true);
            assertEquals(200,request(address,path,"PUT",TOKEN,body,null).getInt("status"));
            server.close(); server = new PhoneSyncServer(data); server.start(0); address = "http://127.0.0.1:" + server.getPort();
            body.put("baseRevision",1).put("deleted",false);
            JSONObject blocked=request(address,path,"PUT",TOKEN,body,null);
            assertEquals(409,blocked.getInt("status")); assertTrue(blocked.getJSONObject("data").getJSONObject("current").getBoolean("deleted"));
        } finally { server.close(); }
    }
}
