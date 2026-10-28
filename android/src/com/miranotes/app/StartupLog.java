package com.miranotes.app;

import android.content.Context;
import android.os.Build;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;

/** Local technical diagnostics only; never reads notebook storage or connection codes. */
final class StartupLog {
    static String describe(Context context, String stage, Throwable failure) {
        String version = "unknown";
        try { version = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName; }
        catch (Exception ignored) {}
        StringWriter stack = new StringWriter(); failure.printStackTrace(new PrintWriter(stack));
        String report = "NoteMark " + version + "\nAndroid " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")\n" +
            Build.MANUFACTURER + " " + Build.MODEL + "\nStage: " + stage + "\n\n" + stack;
        return report.substring(0, Math.min(report.length(), 32000));
    }
    static void record(Context context, String stage, Throwable failure) {
        try (FileOutputStream out = new FileOutputStream(new File(context.getFilesDir(), "startup-error.txt"))) {
            out.write(describe(context, stage, failure).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { /* Diagnostics must never prevent startup or touch saved notes. */ }
    }
}
