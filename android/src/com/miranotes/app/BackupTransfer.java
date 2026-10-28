package com.miranotes.app;

import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.UUID;

/** Bounded sequential binary transfer. The web page can never select a filesystem path. */
final class BackupTransfer implements AutoCloseable {
    static final long MAX_BYTES = 64L * 1024 * 1024;
    private final File cache;
    private File file;
    private FileOutputStream out;
    private String transfer, name, mime;
    private int sequence;
    private long length;
    BackupTransfer(File cache) { this.cache = cache; }
    synchronized JSONObject start(String name, String mime) throws Exception {
        if (file != null) throw new IOException("Finish saving the current backup first.");
        if (!("application/zip".equals(mime) && name.matches("NoteMark-[A-Za-z0-9-]+\\.zip") ||
            "application/json".equals(mime) && name.matches("NoteMark-[A-Za-z0-9-]+\\.json"))) throw new IOException("Invalid backup name or type.");
        this.name = name; this.mime = mime; transfer = UUID.randomUUID().toString(); sequence = 0; length = 0;
        file = File.createTempFile("notemark-export-", ".tmp", cache); out = new FileOutputStream(file);
        return new JSONObject().put("transfer", transfer);
    }
    synchronized void chunk(String id, int index, String encoded) throws Exception {
        check(id);
        if (index != sequence || encoded.length() > 90000 || !encoded.matches("[A-Za-z0-9+/]*={0,2}")) throw new IOException("Invalid backup chunk.");
        byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
        if (bytes.length > 65536 || length + bytes.length > MAX_BYTES) throw new IOException("Backup exceeds 64 MB.");
        out.write(bytes); length += bytes.length; sequence++;
    }
    synchronized Finished finish(String id) throws Exception {
        check(id); if (length == 0) throw new IOException("Backup is empty.");
        out.flush(); out.getFD().sync(); out.close(); out = null;
        Finished result = new Finished(file, name, mime); file = null; transfer = null; return result;
    }
    synchronized void cancel(String id) throws IOException { check(id); close(); }
    private void check(String id) throws IOException { if (file == null || transfer == null || !transfer.equals(id)) throw new IOException("Backup transfer is unavailable."); }
    @Override public synchronized void close() {
        if (out != null) try { out.close(); } catch (IOException ignored) {}
        if (file != null) file.delete(); out = null; file = null; transfer = null;
    }
    static final class Finished {
        final File file; final String name, mime;
        Finished(File file, String name, String mime) { this.file = file; this.name = name; this.mime = mime; }
    }
}
