# NoteMark for Android 1.1.9

Version code 15 retains the original signing certificate, package and storage origin. The mobile editor supports direct touch dragging from each dotted checklist handle and wraps long titles and checklist text; unfinished Add item text is stored as a normal checklist item on each input. Pausing or saving the Activity requests a final mira-save field flush.

The APK uses the fresh single-writer ZIP packaging repair verified on the POCO F6 in 1.1.5. Android 16 previously rejected inconsistent DEX ZIP metadata before starting MainActivity; see the release verification notes. Startup recovery and the working phone identity remain unchanged. Version 1.1.9 is validated with framework and package checks; no USB phone was connected for a new physical install. New checklist addition timestamps and custom ordering use the existing encrypted payload and backup manifest; update both apps to retain that metadata.

Native Java WebView host for the shared interface in `../web/`. Android 8.0 (API 26) or later and an up-to-date Android System WebView are required. The manifest targets Android 16 / API 36. No Gradle downloads or third-party Android libraries are needed.

Requires Node.js 24+ with the pinned fflate dependency installed by npm ci. From the project directory, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1
```

Set JAVA_HOME and ANDROID_HOME to your JDK 17 and Android SDK directories. Override `-JavaHome`, `-AndroidSdk`, or `-BuildToolsVersion` for another machine. It packages a fresh copy of `web/` each time, compiles resources and Java, generates Dalvik bytecode, aligns the APK, signs it, then verifies its signature and manifest. Output is `../releases/NoteMark-Android.apk`.

The workspace `debug.keystore` is a development signing key with the public password `android`. Keep it to preserve update compatibility for these development builds. Use a private production signing key for app-store publication.

## Native behavior

NoteMark 1.1.0 retains the startup recovery introduced in Android 1.0.4: WebView initialization is deferred until window setup finishes, and networking/phone hosting initializes lazily. A failed WebView provider or renderer shows native recovery controls. Private startup-error.txt diagnostics do not read note storage. Package, signing key and notebook origin are unchanged. Update the hosting app/server to 1.1.0 for terminal permanent deletion.

- Local HTML/CSS/JavaScript is served only from `https://appassets.androidplatform.net/assets/` with traversal checks, MIME types, and a content security policy. Notes and settings persist in WebView local storage.
- A restricted asynchronous `MiraAndroid` bridge is exposed only to the bundled index document. It supports JSON Mira API requests and phone hosting controls. It cannot open arbitrary files or execute shell commands. Frames, remote scripts and remote navigation are blocked; HTTP/HTTPS links open the external browser.
- Sync uses `HttpURLConnection` with explicit timeouts, bounded JSON bodies/responses, allowed API paths/methods, no redirects, and default TLS certificate verification. HTTP is limited to private IP addresses/loopback; internet endpoints require HTTPS.
- **Host from this phone** starts an HTTPS IPv4 Wi-Fi server on port 47821, plus a separate HTTP listener bound only to 127.0.0.1 on an OS-selected port. Windows can join with the phone's private connection code. Only local/loopback peers are accepted. Only loopback can create notebooks. Tokens are stored as SHA-256 digests; notes remain encrypted by the shared client. Writes are serialized and atomically replaced, with revision conflicts, authentication throttling and storage quotas (8 notebooks, 5,000 notes/notebook, 64 MiB/notebook, 128 MiB total).
- Phone hosting keeps the screen awake while foregrounded, stops on Activity destruction, and restarts on open if enabled. Stop phone hosting disables restart and retains the encrypted data. It is not an always-on background service.
- Cleartext HTTP is permitted for a user-configured LAN server. Use an HTTPS endpoint for access over the internet.
- The document picker imports ZIP or legacy JSON without broad storage permission. The bundled UI transfers binary ZIP backups in bounded 64 KiB chunks into an app-owned temporary file (maximum 64 MiB), then opens ACTION_CREATE_DOCUMENT. Saving streams the file off the UI thread; cancellation, failure and Activity cleanup remove temporary files without changing notes. Older JSON download fallbacks remain available for recovery.
- Android back dispatches a cancellable `mira-back` event so the shared interface can close an editor or dialog first. When unhandled, back uses page history and then asks before closing the app.
- System-bar, display-cutout, and keyboard insets keep the interface visible on current Android versions.

The packaged interface runs offline. Cross-device sync requires both devices to use the same reachable notebook and private connection code. The phone can host on the same Wi-Fi; it does not deploy an internet server.

At target SDK 36, Android grants LAN access through `INTERNET`. Android 16's local-network restriction is opt-in; this app does not enable that compatibility flag. Android's current guidance says to request `ACCESS_LOCAL_NETWORK` only when upgrading to target SDK 37. See [Android local network permissions](https://developer.android.com/privacy-and-security/local-network-permission?hl=en). Sync requests now use the native transport instead of WebView fetch, so browser mixed-content/CORS enforcement does not govern those requests. Android platform network permissions still apply. Physical-phone Wi-Fi testing remains necessary.
