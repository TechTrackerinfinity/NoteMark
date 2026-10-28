package com.miranotes.app;
public final class PackagedApkRunner extends org.robolectric.RobolectricTestRunner {
    public PackagedApkRunner(Class<?> test) throws org.junit.runners.model.InitializationError { super(test); }
    @Override protected java.util.Properties getBuildSystemApiProperties() {
        java.nio.file.Path root=java.nio.file.Paths.get("..").toAbsolutePath().normalize();
        java.util.Properties p=new java.util.Properties();
        p.setProperty("android_merged_manifest",root.resolve("android/AndroidManifest.xml").toUri().toString());
        p.setProperty("android_merged_resources",root.resolve("android/res").toUri().toString());
        p.setProperty("android_merged_assets",root.resolve("android/build/assets").toUri().toString());
        String apk=System.getenv("MIRA_TEST_APK");
        p.setProperty("android_resource_apk",(apk==null?root.resolve("releases/NoteMark-Android.apk"):java.nio.file.Paths.get(apk)).toUri().toString());
        p.setProperty("android_custom_package","com.miranotes.app"); return p;
    }
}
