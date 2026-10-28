package com.miranotes.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.math.BigInteger;
import java.net.Socket;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.KeyStoreException;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Calendar;
import java.util.Locale;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509KeyManager;
import javax.security.auth.x500.X500Principal;

/** The existing phone-host identity stays in AndroidKeyStore across app upgrades. */
final class PhoneIdentity {
    private static final String ALIAS = "mira-notes-phone-sync-tls-v2";
    final SSLContext context;
    final String fingerprint;

    PhoneIdentity() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore");
            generator.initialize(keySpec()); generator.generateKeyPair();
        }
        final PrivateKey key = (PrivateKey) store.getKey(ALIAS, null);
        final X509Certificate certificate = (X509Certificate) store.getCertificate(ALIAS);
        if (key == null || certificate == null) throw new KeyStoreException("Phone identity is unavailable.");
        fingerprint = fingerprint(certificate);
        X509KeyManager manager = new X509KeyManager() {
            @Override public String[] getClientAliases(String type, Principal[] issuers) { return null; }
            @Override public String chooseClientAlias(String[] types, Principal[] issuers, Socket socket) { return null; }
            @Override public String[] getServerAliases(String type, Principal[] issuers) {
                return "RSA".equalsIgnoreCase(type) ? new String[] { ALIAS } : null;
            }
            @Override public String chooseServerAlias(String type, Principal[] issuers, Socket socket) {
                return "RSA".equalsIgnoreCase(type) ? ALIAS : null;
            }
            @Override public X509Certificate[] getCertificateChain(String alias) {
                return ALIAS.equals(alias) ? new X509Certificate[] { certificate } : null;
            }
            @Override public PrivateKey getPrivateKey(String alias) { return ALIAS.equals(alias) ? key : null; }
        };
        context = SSLContext.getInstance("TLS"); context.init(new KeyManager[] { manager }, null, new SecureRandom());
    }

    static KeyGenParameterSpec keySpec() {
        Calendar from = Calendar.getInstance(); from.add(Calendar.DAY_OF_YEAR, -1);
        Calendar until = Calendar.getInstance(); until.add(Calendar.YEAR, 25);
        return new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(2048).setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256,
                KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
            .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1, KeyProperties.SIGNATURE_PADDING_RSA_PSS)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE, KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1)
            .setRandomizedEncryptionRequired(false)
            .setCertificateSubject(new X500Principal("CN=Mira Notes Phone"))
            .setCertificateSerialNumber(new BigInteger(128, new SecureRandom()).abs().add(BigInteger.ONE))
            .setCertificateNotBefore(from.getTime()).setCertificateNotAfter(until.getTime()).build();
    }

    static String fingerprint(X509Certificate certificate) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()))
            result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
