package com.miranotes.app;
import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import android.webkit.WebView;
@RunWith(PackagedApkRunner.class) @Config(sdk=35)
@org.robolectric.annotation.ResourcesMode(org.robolectric.annotation.ResourcesMode.Mode.BINARY)
public class PackagedStartupTest {
    @Test public void packagedManifestThemeIconAssetsAndLaunchAreValid() throws Exception {
        try(ActivityController<MainActivity> c=Robolectric.buildActivity(MainActivity.class)) {
            c.create().start().resume().visible(); Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            MainActivity a=c.get(); assertEquals("com.miranotes.app",a.getPackageName());
            assertEquals(36,a.getApplicationInfo().targetSdkVersion);
            android.content.pm.ActivityInfo info=a.getPackageManager().getActivityInfo(new android.content.ComponentName(a,MainActivity.class),0);
            assertEquals(android.app.Application.class.getName(), a.getApplication().getClass().getName());
            assertTrue((info.flags & android.content.pm.ActivityInfo.FLAG_HARDWARE_ACCELERATED) != 0);
            assertEquals("NoteMark",a.getApplicationInfo().loadLabel(a.getPackageManager()));
            assertNotNull(a.getApplicationInfo().loadIcon(a.getPackageManager()));
            android.util.TypedValue value=new android.util.TypedValue();
            assertTrue(a.getTheme().resolveAttribute(android.R.attr.colorAccent,value,true)); assertEquals(0xff2563eb,value.data);
            try(java.io.InputStream in=a.getAssets().open("web/index.html")){assertTrue(in.read()>=0);}
            android.view.ViewGroup root=(android.view.ViewGroup)((android.view.ViewGroup)a.findViewById(android.R.id.content)).getChildAt(0);
            assertTrue(root.getChildAt(0) instanceof WebView); assertFalse(a.isFinishing());
            assertEquals("https://appassets.androidplatform.net/assets/index.html",Shadows.shadowOf((WebView)root.getChildAt(0)).getLastLoadedUrl());
        }
    }
}
