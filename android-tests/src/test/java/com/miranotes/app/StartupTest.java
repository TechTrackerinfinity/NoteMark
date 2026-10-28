package com.miranotes.app;

import static org.junit.Assert.*;
import android.webkit.WebView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.Shadows;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
public class StartupTest {
    @Test public void obsoleteStartupMarkerCannotCloseOrRedirectTheWorkingLauncher() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.get(); activity.setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            activity.getSharedPreferences("notemark-startup", android.content.Context.MODE_PRIVATE).edit()
                .putBoolean("opening",true).putInt("pid",android.os.Process.myPid()+100).putLong("time",System.currentTimeMillis()-1000).commit();
            controller.create().start().resume().visible(); Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertNull(Shadows.shadowOf(activity).getNextStartedActivity());
            assertFalse(activity.isFinishing());
            android.view.ViewGroup content=activity.findViewById(android.R.id.content);
            assertTrue(((android.view.ViewGroup)content.getChildAt(0)).getChildAt(0) instanceof WebView);
        }
    }
    @Test public void freshLaunchCreatesWindowAndLoadsNotebook() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.get();
            activity.setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            controller.create().start().resume().visible();
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            android.view.ViewGroup content = activity.findViewById(android.R.id.content);
            assertNotNull(content);
            android.view.ViewGroup root = (android.view.ViewGroup) content.getChildAt(0);
            assertTrue(root.getChildAt(0) instanceof WebView);
            WebView web = (WebView) root.getChildAt(0);
            assertEquals("https://appassets.androidplatform.net/assets/index.html", Shadows.shadowOf(web).getLastLoadedUrl());
            assertTrue(web.getSettings().getDomStorageEnabled());
            assertTrue(web.getSettings().getJavaScriptEnabled());
            assertEquals(android.view.View.LAYER_TYPE_NONE, web.getLayerType());
            assertTrue(Shadows.shadowOf(web).getJavascriptInterface("MiraAndroid") instanceof AndroidBridge);
        }
    }

    @Test public void keyboardAndSystemBarInsetsStillReachTheNotebook() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.get();
            activity.setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            controller.create().start().resume().visible();
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            android.view.ViewGroup content = activity.findViewById(android.R.id.content);
            android.view.View root = content.getChildAt(0);
            android.view.WindowInsets insets = new android.view.WindowInsets.Builder()
                .setInsets(android.view.WindowInsets.Type.systemBars(), android.graphics.Insets.of(0, 80, 0, 70))
                .setInsets(android.view.WindowInsets.Type.ime(), android.graphics.Insets.of(0, 0, 0, 300))
                .build();
            root.dispatchApplyWindowInsets(insets);
            assertEquals(80, root.getPaddingTop());
            assertEquals(300, root.getPaddingBottom());
        }
    }

    @Test public void leavingTheActivityRequestsPendingEditorFieldsBeforePausing() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            controller.get().setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            controller.create().start().resume().visible(); Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            android.view.ViewGroup root = (android.view.ViewGroup) ((android.view.ViewGroup) controller.get().findViewById(android.R.id.content)).getChildAt(0);
            WebView web = (WebView) root.getChildAt(0);
            controller.pause();
            assertEquals("window.dispatchEvent(new Event('mira-save'));", Shadows.shadowOf(web).getLastEvaluatedJavascript());
            assertFalse(controller.get().isFinishing());
        }
    }

    @Test public void backgroundSaveAndRecreationDoNotCrash() {
        android.os.Bundle state = new android.os.Bundle();
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            controller.get().setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            controller.create().start().resume().visible();
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            controller.pause().saveInstanceState(state).stop();
        }
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            controller.get().setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            controller.create(state).start().restoreInstanceState(state).resume().visible();
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertNotNull(controller.get().findViewById(android.R.id.content));
        }
    }

    @Test public void nativeHostingDoesNotInitializeDuringActivityStartup() throws Exception {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            controller.get().setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            controller.create().start().resume().visible(); Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            android.view.ViewGroup root = (android.view.ViewGroup) ((android.view.ViewGroup) controller.get().findViewById(android.R.id.content)).getChildAt(0);
            WebView web = (WebView) root.getChildAt(0);
            Object bridge = Shadows.shadowOf(web).getJavascriptInterface("MiraAndroid");
            for (String field : new String[] { "server", "workers", "preferences" }) {
                java.lang.reflect.Field member = AndroidBridge.class.getDeclaredField(field); member.setAccessible(true);
                assertNull("Eager startup initialization: " + field, member.get(bridge));
            }
        }
    }

    @Test public void webViewRendererFailureKeepsActivityOpenAndAllowsRetry() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.get(); activity.setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            controller.create().start().resume().visible(); Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            android.view.ViewGroup root = (android.view.ViewGroup) ((android.view.ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
            WebView web = (WebView) root.getChildAt(0);
            assertTrue(Shadows.shadowOf(web).getWebViewClient().onRenderProcessGone(web, new android.webkit.RenderProcessGoneDetail() {
                @Override public boolean didCrash() { return true; }
                @Override public int rendererPriorityAtExit() { return WebView.RENDERER_PRIORITY_IMPORTANT; }
            }));
            assertFalse(activity.isFinishing()); assertTrue(root.getChildAt(0) instanceof android.widget.LinearLayout);
            android.widget.LinearLayout recovery = (android.widget.LinearLayout) root.getChildAt(0);
            assertTrue(((android.widget.TextView) recovery.getChildAt(0)).getText().toString().contains("notebook is safe"));
            recovery.getChildAt(2).performClick();
            assertTrue(root.getChildAt(0) instanceof WebView);
        }
    }

    @Test @Config(shadows = FailingWebView.class)
    public void unavailableWebViewShowsRecoveryInsteadOfClosingOrClearingFiles() throws Exception {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.get(); activity.setTheme(android.R.style.Theme_Material_Light_NoActionBar);
            java.io.File marker = new java.io.File(activity.getFilesDir(), "notebook-preservation-marker");
            java.nio.file.Files.writeString(marker.toPath(), "keep existing data");
            controller.create().start().resume().visible(); Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertFalse(activity.isFinishing());
            android.view.ViewGroup root = (android.view.ViewGroup) ((android.view.ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
            assertTrue(root.getChildAt(0) instanceof android.widget.LinearLayout);
            assertEquals("keep existing data", java.nio.file.Files.readString(marker.toPath()));
            String report = java.nio.file.Files.readString(new java.io.File(activity.getFilesDir(), "startup-error.txt").toPath());
            assertTrue(report.contains("simulated provider startup failure"));
        }
    }

    @org.robolectric.annotation.Implements(WebView.class)
    public static class FailingWebView extends org.robolectric.shadows.ShadowWebView {
        @org.robolectric.annotation.Implementation protected void __constructor__(android.content.Context context) {
            throw new android.util.AndroidRuntimeException("simulated provider startup failure");
        }
    }
}
