# Android startup regression tests

These tests run the real `MainActivity` against Robolectric's Android 15 framework. They cover cold launch, keyboard/system-bar insets, and saving/recreating the Activity. They do not run Chromium/WebView's JavaScript engine or replace testing on a physical phone.

There are now 24 Android15 tests: eight startup/lifecycle/recovery/pause-save checks, one packaged-resource check, seven phone server/native-network checks, five TLS/identity checks and three binary-backup checks. Production sources use the release Java8 format. TLS tests perform real handshakes with a disposable synthetic certificate; they reject incorrect pins and ordinary untrusted certificates and confirm lazy key initialization.

The seven `PhoneSyncTest` tests exercise real sockets and the production Java phone server/native HTTP transport. A Node.js subprocess runs the actual shared JavaScript sync client against the Java server, checking bidirectional encrypted notes/checklists, conflict copies, trash/restore and persistence after server restart. Other cases cover concurrent revision writes, CORS/private-network preflight, wrong credentials, input restrictions, redirect rejection, loopback routing after an address change, and releasing the listening port. Node.js must be available on PATH. The separate Node native-bridge test checks asynchronous callback handling without using browser fetch.

Requires JDK17, Gradle 9, Android SDK36 and the Maven dependencies listed in `build.gradle` (downloaded on the first run). From the source project:

```powershell
gradle -p android-tests test --no-daemon
```

Set `MIRA_ANDROID_JAR` to the absolute path of `platforms/android-36/android.jar` if the SDK is not at `D:/Android`. Tests use Android API35; Robolectric API36 requires JDK21 and is not exercised by this JDK17 configuration.

Before the 1.0.1 fix, `freshLaunchCreatesWindowAndLoadsNotebook` reproduced:

```text
NullPointerException: Cannot invoke DecorView.getWindowInsetsController() because this.mDecor is null
  PhoneWindow.getInsetsController
  MainActivity.configureInsets
  MainActivity.onCreate
```

The activity now installs its content before accessing the decor/insets controller. The same cold-launch test passes after the fix.
