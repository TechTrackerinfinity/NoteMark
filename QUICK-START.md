# NoteMark 1.1.9 — phone and Windows

Text wraps in the mobile editor, including checklist items and titles. Entries in Add item save while you type, even without pressing Add. Reopening shows them as saved checklist items. Add or Enter starts the next item; Shift+Enter inserts a new line. Existing notes and pairing are preserved by an in-place update.

## Update

Windows 10/11, 64-bit: close the running app and run NoteMark-Setup-1.1.9.exe (also Setup.exe). Use the existing installation folder when upgrading. Open the NoteMark shortcut afterward. Notes and pairing stay in %APPDATA%\Mira Notes. Setup requests administrator access and adds an executable-specific TCP 47821 rule restricted to LocalSubnet. It does not open router ports.

Portable: extract the complete NoteMark-Windows.zip to a permanent location and run NoteMark.exe. Settings & sync → Repair Wi-Fi access configures that executable location.

Android 8+: install NoteMark-Android-1.1.9.apk over the existing Mira Notes app. Do not uninstall or clear storage. Package, certificate and storage origin are unchanged; version code is 15. Keep Android System WebView updated. Startup recovery remains available if WebView fails. Update both apps and the hosting server together.

## Phone hosts, Windows connects (same Wi-Fi)

1. On Android open Settings & sync → Host from this phone.
2. Privately transfer its whole connection code to Windows.
3. On Windows choose Connect a device, paste the phone code and connect.
4. Keep both apps open on the same Wi-Fi. Windows can be minimized or covered; keep the hosting phone app in the foreground. Notes sync in both directions.

Working 1.1.3 phone-host pairing, including the certificate fingerprint, is retained. Phone hosting uses local HTTPS verified by the installed apps; the phone UI uses a separate loopback-only HTTP port. If the phone IP changes, reopen its Settings & sync and copy the updated code to Windows. Guest networks/client isolation and VPNs may block local routes.

## Windows hosts

On Windows open Settings & sync, use its Wi-Fi server address, create a notebook and copy its code into Android → Connect a device. Keep Windows open. If this route is blocked, use phone hosting above. Test connection and Open server check in browser distinguish reachability from bad credentials. A current health response includes ok:true, protocol:1 and capabilities.permanentDelete:true.

## Addition times and checklist order

Update both apps to 1.1.9. Notes retain their creation time, and new checklist entries record their device time when first saved. Offline additions merge by those times, oldest first; equal times have a stable identity tie-break. Keep automatic date/time accurate on each device. Earlier checklist entries retain their original sequence because their historical times are unknown.

The dashboard defaults to Oldest first. Other sort choices remain and are saved separately on each device. Pinned notes keep priority. In a checklist, hold the dotted handle beside an item, drag to the blue insertion line, and release. This works directly with a mouse or a finger. Hold near the editor top/bottom to scroll a long list. Release outside the section to cancel, or press Escape while dragging. Show times displays addition times. Alt+Up/Down also works while editing; arrow keys work on a focused handle. Completed items stay in their own section. By time restores time order. Custom ordering syncs and survives restart; new unpositioned items appear at the end. If two devices reorder offline, the later recorded reorder wins, with a deterministic tie-break.

## Notes and Trash

Click a note to edit. Saving is automatic; on desktop, clicking the backdrop also saves and closes. Dragging from inside does not close it. Select enables dashboard checkboxes, Select all visible and Move to Trash. Navigation clears selection.

In Trash, use Restore or Delete forever on a card, or select several notes. Permanent deletion requires confirmation with the note count and applies across the paired notebook after sync. Update the host and sync once before using it. Once support is known, offline deletions queue for reconnect. Permanent deletion cannot be undone through Trash.

Checked checklist items move immediately into Completed; uncheck to return them above. The screen stays at its current scroll position when an item changes sections. Checklist item removal remains inside the editor; whole-note deletion is on the dashboard.

## ZIP backup and restore

Settings & sync → Download ZIP backup creates NoteMark-backup-<date-time>.zip. Android opens the system save picker. Cancelling leaves notes untouched. Backups contain readable text: notes/ and trash/ have one Markdown file per note; backup.json retains checklist states, folders, colors, pinning, trash status and timestamps.

Restore backup accepts this ZIP or older Mira Notes JSON. The whole backup is validated before import as new note copies. Existing notes and sync credentials are retained. Limits: 64 MB compressed, 128 MB expanded and 5,000 notes. Permanent deletions and connection secrets are excluded. If storage is damaged, download raw JSON recovery before changing app data.

## Internet sync later

NoteMark-Sync-Server.zip has the matching service and HTTPS deployment files. Follow deploy/README.md when hosting is chosen. Both devices need the same HTTPS host and private notebook code. A LAN address cannot work away from that network. No hosted server has been deployed. Sync runs while the apps are open.
