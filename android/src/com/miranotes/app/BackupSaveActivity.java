package com.miranotes.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Private, on-demand document picker. The notes launch path does not initialize ZIP saving. */
public final class BackupSaveActivity extends Activity {
    static final int SAVE_BACKUP = 4103;
    private File source;
    private ResultReceiver completion;
    private boolean saving, completed;

    static void launch(Activity owner, BackupTransfer.Finished backup, Runnable finished) {
        ResultReceiver receiver = new ResultReceiver(new Handler(Looper.getMainLooper())) {
            @Override protected void onReceiveResult(int result, Bundle data) { finished.run(); }
        };
        owner.startActivity(new Intent(owner, BackupSaveActivity.class)
            .putExtra("temporaryName", backup.file.getName()).putExtra("name", backup.name)
            .putExtra("mime", backup.mime).putExtra("completion", receiver));
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView message = new TextView(this); message.setText("Save your NoteMark backup");
        message.setGravity(android.view.Gravity.CENTER); setContentView(message);
        try {
            Intent request = getIntent();
            completion = request.getParcelableExtra("completion");
            String temporary = request.getStringExtra("temporaryName");
            String name = request.getStringExtra("name"), mime = request.getStringExtra("mime");
            if (temporary == null || !temporary.matches("notemark-export-[A-Za-z0-9-]+\\.tmp") ||
                name == null || mime == null ||
                !("application/zip".equals(mime) && name.matches("NoteMark-[A-Za-z0-9-]+\\.zip") ||
                  "application/json".equals(mime) && name.matches("NoteMark-[A-Za-z0-9-]+\\.json")))
                throw new IOException("Invalid backup request.");
            File candidate = new File(getCacheDir(), temporary).getCanonicalFile();
            if (!candidate.getParentFile().equals(getCacheDir().getCanonicalFile()) ||
                !candidate.isFile() || candidate.length() == 0 || candidate.length() > BackupTransfer.MAX_BYTES)
                throw new IOException("The temporary backup is unavailable.");
            source = candidate;
            if (state != null) {
                if (state.getBoolean("saving", false)) complete(false, "The backup save was interrupted. Please try again.");
                return; // Android restores the outstanding document picker and result.
            }
            startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE).setType(mime)
                .putExtra(Intent.EXTRA_TITLE, name), SAVE_BACKUP);
        } catch (RuntimeException | IOException failure) { complete(false, "The backup save picker could not open."); }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != SAVE_BACKUP || completed || saving) return;
        if (result != RESULT_OK || data == null || data.getData() == null || source == null) {
            complete(false, null); return;
        }
        final Uri destination = data.getData(); final File input = source; saving = true;
        new Thread(() -> {
            boolean saved = false;
            try (InputStream in = new FileInputStream(input);
                 OutputStream out = getContentResolver().openOutputStream(destination, "wt")) {
                if (out == null) throw new IOException("The document could not be opened.");
                byte[] buffer = new byte[65536]; int count; long total = 0;
                while ((count = in.read(buffer)) != -1) {
                    total += count; if (total > BackupTransfer.MAX_BYTES) throw new IOException("Backup is too large.");
                    out.write(buffer, 0, count);
                }
                out.flush(); saved = true;
            } catch (RuntimeException | IOException failure) { /* Report failure without touching note storage. */ }
            final boolean success = saved;
            runOnUiThread(() -> complete(success, success ? "Backup saved." : "The backup could not be saved."));
        }, "NoteMark-backup-save").start();
    }

    private void complete(boolean success, String message) {
        if (completed) return; completed = true; saving = false;
        if (source != null) source.delete();
        if (completion != null) completion.send(success ? RESULT_OK : RESULT_CANCELED, Bundle.EMPTY);
        if (message != null) Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        finish();
    }
    @Override protected void onSaveInstanceState(Bundle state) { state.putBoolean("saving", saving); super.onSaveInstanceState(state); }
    @Override protected void onDestroy() {
        if (isFinishing() && !saving && !completed) complete(false, null);
        super.onDestroy();
    }
}
