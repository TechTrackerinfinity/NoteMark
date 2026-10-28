import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await writeFile(new URL('README.md',root), `# NoteMark 1.1.0

Offline notes and checklists for Windows and Android, with encrypted sync and a modern light workspace. See QUICK-START.md for installation and pairing.

- Select notes on the dashboard to move them to Trash. Restore or permanently delete individual or selected notes from Trash.
- Completed checklist items appear below unfinished items and the add-item field.
- On desktop, click outside an open note to save and close it, or use Escape/the back button. A save error keeps the editor open.
- Settings & sync offers a ZIP backup with individual Markdown files and a restore manifest. Backups include active and trashed notes as readable text. Restore ZIP or earlier Mira Notes JSON as new copies.
- Permanent deletion removes local contents and syncs encrypted blank tombstones. Deleted identities remain terminal on the hosting server and survive restarts. Update both devices and the hosting server together.

## Develop and build

Use Node.js 24+, npm, JDK 17 and Android SDK 36/build-tools 36.0.0. Electron and builder are pinned in package-lock.json. fflate 0.8.3 is bundled locally in web/vendor/ with its MIT license; no CDN is required.

Run npm ci, npm test, npm run preview, npm run build:android, npm run build:windows, then npm run build:setup. scripts/package-releases.ps1 produces the ZIP deliverables and checksums.

Android regression tests are in android-tests/. Preserve android/debug.keystore privately: the source ZIP excludes signing keys, and rebuilding without the original key cannot update the existing installation.

## Storage and compatibility

Android retains package com.miranotes.app (version code 6), signing key, WebView origin https://appassets.androidplatform.net, storage key mira.notes.v1, mira1 pairing format, phone hosting data and startup recovery.

Windows retains application ID com.miranotes.desktop and explicitly uses %APPDATA%\\Mira Notes. Its executable is NoteMark.exe. NSIS retains the upgrade registry identity and user data; process helpers recognize verified older Mira Notes executables. MIRA_USER_DATA and MIRA_SYNC_PORT remain supported for isolated testing.

Local notes and device keys are readable Chromium/WebView data. Server note contents use AES-GCM; authentication stores token hashes. Backups contain readable notes, exclude credentials/encryption keys/permanent deletions, and should be stored privately.

Internet sync requires an online HTTPS host. deploy/ provides Docker Compose and Caddy setup; hosting remains deferred. Existing Docker volume/project names remain stable to retain server data. Windows builds are unsigned. Android retains the existing personal-development certificate. See VERIFICATION.md for checks and physical-device limits.
`);
await writeFile(new URL('QUICK-START.md',root), `# NoteMark 1.1.0 — phone and Windows

## Update

Windows 10/11, 64-bit: close the running app and run NoteMark-Setup-1.1.0.exe (also Setup.exe). Use the existing installation folder when upgrading. Open the NoteMark shortcut afterward. Notes and pairing stay in %APPDATA%\\Mira Notes. Setup requests administrator access and adds an executable-specific TCP 47821 rule restricted to LocalSubnet. It does not open router ports.

Portable: extract the complete NoteMark-Windows.zip to a permanent location and run NoteMark.exe. Settings & sync → Repair Wi-Fi access configures that executable location.

Android 8+: install NoteMark-Android-1.1.0.apk over the existing Mira Notes app. Do not uninstall or clear storage. Package, certificate and storage origin are unchanged; version code is 6. Keep Android System WebView updated. Startup recovery remains available if WebView fails. Update both apps and the hosting server together.

## Phone hosts, Windows connects (same Wi-Fi)

1. On Android open Settings & sync → Host from this phone.
2. Privately transfer its whole connection code to Windows.
3. On Windows choose Connect a device, paste the phone code and connect.
4. Keep both apps open on the same Wi-Fi. Notes sync in both directions.

Working phone-host pairing is retained. If the phone IP changes, reopen its Settings & sync and copy the updated code to Windows. Guest networks/client isolation and VPNs may block local routes.

## Windows hosts

On Windows open Settings & sync, use its Wi-Fi server address, create a notebook and copy its code into Android → Connect a device. Keep Windows open. If this route is blocked, use phone hosting above. Test connection and Open server check in browser distinguish reachability from bad credentials. A current health response includes ok:true, protocol:1 and capabilities.permanentDelete:true.

## Notes and Trash

Click a note to edit. Saving is automatic; on desktop, clicking the backdrop also saves and closes. Dragging from inside does not close it. Select enables dashboard checkboxes, Select all visible and Move to Trash. Navigation clears selection.

In Trash, use Restore or Delete forever on a card, or select several notes. Permanent deletion requires confirmation with the note count and applies across the paired notebook after sync. Update the host and sync once before using it. Once support is known, offline deletions queue for reconnect. Permanent deletion cannot be undone through Trash.

Checked checklist items move immediately into Completed; uncheck to return them above. Checklist item removal remains inside the editor; whole-note deletion is on the dashboard.

## ZIP backup and restore

Settings & sync → Download ZIP backup creates NoteMark-backup-<date-time>.zip. Android opens the system save picker. Cancelling leaves notes untouched. Backups contain readable text: notes/ and trash/ have one Markdown file per note; backup.json retains checklist states, folders, colors, pinning, trash status and timestamps.

Restore backup accepts this ZIP or older Mira Notes JSON. The whole backup is validated before import as new note copies. Existing notes and sync credentials are retained. Limits: 64 MB compressed, 128 MB expanded and 5,000 notes. Permanent deletions and connection secrets are excluded. If storage is damaged, download raw JSON recovery before changing app data.

## Internet sync later

NoteMark-Sync-Server.zip has the matching service and HTTPS deployment files. Follow deploy/README.md when hosting is chosen. Both devices need the same HTTPS host and private notebook code. A LAN address cannot work away from that network. No hosted server has been deployed. Sync runs while the apps are open.
`);
for(const path of ['server/README.md','server/cli.mjs','deploy/README.md','deploy/Caddyfile','scripts/preview.mjs','android/README.md']) {
 let value=await readFile(new URL(path,root),'utf8'); value=value.replaceAll('Mira Notes','NoteMark').replaceAll('Mira-Notes-Android.apk','NoteMark-Android.apk'); await writeFile(new URL(path,root),value);
}
