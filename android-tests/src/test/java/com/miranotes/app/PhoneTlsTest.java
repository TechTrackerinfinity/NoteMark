package com.miranotes.app;

import static org.junit.Assert.*;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
public class PhoneTlsTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static SSLContext tls;
    private static X509Certificate certificate;
    private static String fingerprint;
    private static final String TOKEN = encoded(32, 7);

    private static String encoded(int length, int value) {
        byte[] bytes = new byte[length]; Arrays.fill(bytes, (byte) value);
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    @BeforeClass public static void syntheticTlsIdentity() throws Exception {
        // A disposable identity is generated for these tests; never read the APK signing key.
        File folder = Files.createTempDirectory("notemark-tls-test-").toFile();
        File storeFile = new File(folder, "synthetic.p12");
        try {
            File keytool = new File(System.getProperty("java.home"), "bin/keytool.exe");
            Process process = new ProcessBuilder(keytool.toString(), "-genkeypair", "-noprompt", "-alias", "test",
                "-keyalg", "RSA", "-keysize", "2048", "-validity", "2", "-dname", "CN=Synthetic NoteMark Test",
                "-storetype", "PKCS12", "-keystore", storeFile.toString(), "-storepass", "test-password")
                .redirectErrorStream(true).start();
            if (!process.waitFor(20, TimeUnit.SECONDS)) { process.destroyForcibly(); fail("Synthetic TLS key generation timed out"); }
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals(output, 0, process.exitValue());
            KeyStore keys = KeyStore.getInstance("PKCS12");
            try (InputStream in = Files.newInputStream(storeFile.toPath())) { keys.load(in, "test-password".toCharArray()); }
            certificate = (X509Certificate) keys.getCertificate("test");
            fingerprint = PhoneIdentity.fingerprint(certificate);
            KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            managers.init(keys, "test-password".toCharArray());
            // Robolectric installs Conscrypt after @BeforeClass. Select it explicitly so
            // a SunJSSE server cannot later mix its EC parameter setup with Conscrypt.
            java.security.Provider provider = (java.security.Provider) Class.forName("org.conscrypt.OpenSSLProvider")
                .getDeclaredConstructor().newInstance();
            tls = SSLContext.getInstance("TLS", provider); tls.init(managers.getKeyManagers(), null, null);
        } finally { Files.deleteIfExists(storeFile.toPath()); Files.deleteIfExists(folder.toPath()); }
    }

    private JSONObject request(String url, String method, String token, String pin, JSONObject body, PhoneSyncServer local) throws Exception {
        JSONObject args = new JSONObject().put("url", url).put("method", method).put("token", token)
            .put("body", body == null ? "" : body.toString());
        if (pin != null) args.put("fingerprint", pin);
        return NativeHttp.request(args, local);
    }

    @Test public void pinnedHttpsAndPrivateLoopbackKeepTerminalDeletionAcrossRestart() throws Exception {
        File data = temporary.newFolder(); String vault = UUID.randomUUID().toString(), note = UUID.randomUUID().toString();
        PhoneSyncServer server = new PhoneSyncServer(data, tls);
        try {
            server.start(0); assertEquals("https", server.getScheme()); assertNotEquals(server.getPort(), server.getLoopbackPort());
            String local = "http://127.0.0.1:" + server.getLoopbackPort();
            assertEquals(201, request(local + "/api/vaults", "POST", "", null,
                new JSONObject().put("id", vault).put("token", TOKEN), null).getInt("status"));
            String remote = "https://127.0.0.1:" + server.getPort();
            assertTrue(request(remote + "/api/health", "GET", "", fingerprint.toUpperCase(), null, null)
                .getJSONObject("data").getJSONObject("capabilities").getBoolean("permanentDelete"));
            String path = "/api/vaults/" + vault + "/notes/" + note;
            JSONObject encrypted = new JSONObject().put("baseRevision", 0).put("iv", encoded(12, 1))
                .put("ciphertext", encoded(32, 2)).put("deleted", true);
            assertEquals(200, request(remote + path, "PUT", TOKEN, fingerprint, encrypted, null).getInt("status"));
            // An obsolete Wi-Fi IP routes only authenticated owned notebook requests through the separate local port.
            assertEquals(200, request("https://192.168.77.254:47821/api/vaults/" + vault + "/notes", "GET", TOKEN,
                fingerprint, null, server).getInt("status"));
            server.close(); server = new PhoneSyncServer(data, tls); server.start(0);
            remote = "https://127.0.0.1:" + server.getPort();
            encrypted.put("baseRevision", 1).put("deleted", false);
            JSONObject stale = request(remote + path, "PUT", TOKEN, fingerprint, encrypted, null);
            assertEquals(409, stale.getInt("status")); assertTrue(stale.getJSONObject("data").getJSONObject("current").getBoolean("deleted"));
        } finally { server.close(); }
    }

    @Test public void wrongPinAndUntrustedCertificateFailWithoutDisablingNormalTls() throws Exception {
        try (PhoneSyncServer server = new PhoneSyncServer(temporary.newFolder(), tls)) {
            server.start(0); String url = "https://127.0.0.1:" + server.getPort() + "/api/health";
            try { request(url, "GET", "", "0".repeat(64), null, null); fail("Wrong pin accepted"); }
            catch (javax.net.ssl.SSLException expected) { }
            try { request(url, "GET", "", null, null, null); fail("Self-signed certificate accepted without a pin"); }
            catch (javax.net.ssl.SSLException expected) { }
            assertEquals(200, request(url, "GET", "", fingerprint, null, null).getInt("status"));
        }
    }

    @Test public void invalidOrRemotePinsAreRejectedBeforeNetworkAccess() throws Exception {
        for (String url : new String[] { "http://127.0.0.1:1/api/health", "https://example.com/api/health" }) {
            try { request(url, "GET", "", fingerprint, null, null); fail("Unsafe pinned address accepted"); }
            catch (java.io.IOException expected) { assertTrue(expected.getMessage().contains("local HTTPS")); }
        }
        try {
            NativeHttp.request(new JSONObject().put("url", "https://127.0.0.1:1/api/health")
                .put("method", "GET").put("fingerprint", 42), null); fail("Non-string pin accepted");
        } catch (java.io.IOException expected) { assertTrue(expected.getMessage().contains("fingerprint")); }
        assertTrue(fingerprint.matches("[a-f0-9]{64}")); assertEquals(64, fingerprint.length());
    }

    @Test public void androidIdentityUsesExistingAliasAndProviderCompatibleSigningPurposes() {
        KeyGenParameterSpec spec = PhoneIdentity.keySpec();
        assertEquals("mira-notes-phone-sync-tls-v2", spec.getKeystoreAlias());
        assertEquals(KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_DECRYPT, spec.getPurposes());
        assertEquals(2048, spec.getKeySize());
        assertTrue(Arrays.asList(spec.getDigests()).contains(KeyProperties.DIGEST_SHA256));
        assertTrue(Arrays.asList(spec.getSignaturePaddings()).contains(KeyProperties.SIGNATURE_PADDING_RSA_PSS));
    }

    @Test public void disabledHostInfoDoesNotInitializeKeysListenersOrStorage() throws Exception {
        android.app.Activity activity = org.robolectric.Robolectric.buildActivity(android.app.Activity.class).setup().get();
        android.webkit.WebView web = new android.webkit.WebView(activity);
        try (AndroidBridge bridge = new AndroidBridge(activity, web)) {
            java.lang.reflect.Method info = AndroidBridge.class.getDeclaredMethod("info", JSONObject.class); info.setAccessible(true);
            JSONObject result = (JSONObject) info.invoke(bridge,
                new JSONObject().put("id", UUID.randomUUID().toString()).put("token", TOKEN));
            assertFalse(result.getBoolean("running")); assertFalse(result.getBoolean("ownsNotebook"));
            assertEquals("https", result.getString("scheme")); assertEquals("", result.getString("fingerprint"));
            for (String name : new String[] { "identity", "server", "workers" }) {
                java.lang.reflect.Field field = AndroidBridge.class.getDeclaredField(name); field.setAccessible(true); assertNull(field.get(bridge));
            }
            assertFalse(new File(activity.getFilesDir(), "phone-sync-data").exists());
        } finally { web.destroy(); activity.finish(); }
    }
}
