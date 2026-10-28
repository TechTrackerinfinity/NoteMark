import { Notebook, SyncEngine, colors, createVault, checkVault, pairingCode, parsePairing, payload, probeServer, normalizeServer, compareNotes } from './core.mjs';
import { androidNative, desktopNative, nativeCall } from './native.mjs';
import { icon, hydrateIcons } from './icons.mjs';
import { checklistDrag } from './checklist-drag.mjs';
import { createBackup, readBackup, backupFilename, MAX_ARCHIVE } from './backup.mjs';
const $ = id => document.getElementById(id);
const book = new Notebook();
const engine = new SyncEngine(book);
let filter = 'all', active = null, search = '', toastTimer, desktopInfo = null, phoneInfo = null, connecting = false, lastError = '', editorVersion = '';
let selecting = false, selected = new Set(), visibleIds = [], deleteIds = [], outsideDown = false, composing = false, draftTaskId = null, reordering = false;
let taskDrag = null;
hydrateIcons();
const names = { all: 'All notes', pinned: 'Pinned', tasks: 'Checklists', trash: 'Trash' };
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = time => new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const dateTime = time => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
try { const preference = localStorage.getItem('notemark.sort.v1'); if (['oldest','updated','created','title'].includes(preference)) $('sort').value = preference; } catch { /* Notes can still be viewed without a saved sort preference. */ }
function toast(message, error = false) { $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 7000 : 3500); }
function safely(fn) { try { return fn(); } catch (e) { toast('Could not save: ' + e.message, true); $('editor-status').textContent = 'Save failed — export a backup'; } }
function allFolders() { return [...new Set([...book.state.folders, ...Object.values(book.state.notes).filter(n => !n.trashed && n.folder).map(n => n.folder)])].sort((a, b) => a.localeCompare(b)); }
function render() {
  const focusedSelection = document.activeElement?.dataset.select, focusedCard = document.activeElement?.dataset.open;
  const all = Object.values(book.state.notes), live = all.filter(n => !n.trashed);
  $('all-count').textContent = live.length;
  $('trash-count').textContent = all.length - live.length;
  const label = names[filter] || filter.slice(7);
  $('breadcrumb-title').textContent = label;
  $('page-title').textContent = label;
  $('page-subtitle').textContent = filter === 'trash' ? 'Restore what you need. Let go of the rest.' : filter === 'pinned' ? 'Your important ideas, always within reach.' : filter === 'tasks' ? 'A clear plan. One check at a time.' : 'Make room for your next idea.';
  $('section-label').textContent = search ? 'SEARCH RESULTS' : filter === 'trash' ? 'IN YOUR TRASH' : 'YOUR NOTES';
  $('new-note').hidden = filter === 'trash';
  for (const el of document.querySelectorAll('[data-filter]')) el.classList.toggle('active', el.dataset.filter === filter);
  $('folders').innerHTML = allFolders().map(f => `<button class="folder-nav ${filter === 'folder:' + f ? 'active' : ''}" data-folder="${escape(f)}">${icon('folder')}<span>${escape(f)}</span></button>`).join('');
  $('folder-options').innerHTML = allFolders().map(f => `<option value="${escape(f)}"></option>`).join('');
  for (const el of $('mobile-filters').querySelectorAll('[data-folder-chip]')) el.remove();
  for (const f of allFolders()) { const chip = document.createElement('button'); chip.dataset.filter = 'folder:' + f; chip.dataset.folderChip = ''; chip.textContent = f; chip.classList.toggle('active', filter === 'folder:' + f); $('mobile-filters').append(chip); }
  const q = search.toLocaleLowerCase();
  const notes = all.filter(n => (filter === 'trash' ? n.trashed : !n.trashed) && (filter !== 'pinned' || n.pinned) && (filter !== 'tasks' || n.type === 'task') && (!filter.startsWith('folder:') || n.folder === filter.slice(7)) && (!q || [n.title, n.body, n.folder, ...n.tasks.map(t => t.text)].join('\n').toLocaleLowerCase().includes(q)));
  notes.sort((a, b) => compareNotes(a, b, $('sort').value));
  $('results-count').textContent = notes.length;
  visibleIds = notes.map(n => n.id);
  selected = new Set([...selected].filter(id => visibleIds.includes(id)));
  $('notes-grid').classList.toggle('selection-mode', selecting);
  $('selection-bar').hidden = !selecting;
  $('select-mode-label').textContent = selecting ? 'Done' : 'Select';
  $('select-mode').setAttribute('aria-pressed', String(selecting));
  $('selected-count').textContent = `${selected.size} selected`;
  $('select-all').checked = notes.length > 0 && selected.size === notes.length;
  $('select-all').indeterminate = selected.size > 0 && selected.size < notes.length;
  $('selection-trash').hidden = filter === 'trash'; $('selection-restore').hidden = filter !== 'trash'; $('selection-delete').hidden = filter !== 'trash';
  for (const id of ['selection-trash','selection-restore','selection-delete']) $(id).disabled = !selected.size;
  $('notes-grid').innerHTML = notes.map(n => {
    const tasks = [...n.tasks.filter(t => !t.done), ...n.tasks.filter(t => t.done)];
    const text = n.type === 'task' ? tasks.slice(0, 5).map(t => `<span class="card-task ${t.done ? 'task-done' : ''}"><span class="task-box">${t.done ? icon('check') : ''}</span><span>${escape(t.text || 'Empty item')}</span></span>`).join('') : escape(n.body);
    return `<article class="note-card ${selected.has(n.id) ? 'selected' : ''}" data-color="${n.color}"><button class="card-open" data-open="${n.id}" aria-label="${selecting ? 'Select' : 'Open'} ${escape(n.title || 'Untitled note')}"></button><label class="card-selector"><input type="checkbox" data-select="${n.id}" ${selected.has(n.id) ? 'checked' : ''} aria-label="Select ${escape(n.title || 'Untitled note')}"></label><div class="card-type">${icon(n.type === 'task' ? 'tasks' : 'notes')}<span>${n.type === 'task' ? `${n.tasks.filter(t => t.done).length}/${n.tasks.length} completed` : 'Note'}</span>${n.pinned ? `<span class="card-pin">${icon('pin')}</span>` : ''}</div><h2>${escape(n.title || 'Untitled note')}</h2><div class="card-body ${!text ? 'blank' : ''}">${text || 'Your next idea starts here.'}</div><div class="card-footer"><span>${date(n.updatedAt)}</span>${n.folder ? `<span class="card-folder">${escape(n.folder)}</span>` : ''}</div>${filter === 'trash' ? `<div class="card-trash-actions"><button class="secondary" data-restore="${n.id}">${icon('restore')}Restore</button><button class="danger-button" data-delete="${n.id}" title="Delete permanently">${icon('delete')}Delete forever</button></div>` : ''}</article>`;
  }).join('');
  $('empty-state').style.display = notes.length ? 'none' : 'block';
  const empty = $('empty-state');
  empty.querySelector('h2').textContent = search ? 'No thoughts found.' : filter === 'trash' ? 'Nothing left behind.' : filter === 'all' ? 'A fresh page awaits.' : 'A little space, just for this.';
  empty.querySelector('p').textContent = search ? 'Try a different word or search another folder.' : filter === 'trash' ? 'Notes you move to trash will appear here.' : 'An idea, a list, a little reminder. Give your next thought a home.';
  $('empty-create').hidden = !!search || filter === 'trash';
  $('empty-create').innerHTML = icon('plus') + (live.length ? 'Write a new note' : 'Write your first note');
  $('footer-count').textContent = `${live.length} note${live.length === 1 ? '' : 's'} · ${all.filter(n => n.trashed).length} in trash`;
  if (focusedSelection) document.querySelector(`[data-select="${focusedSelection}"]`)?.focus();
  else if (focusedCard) document.querySelector(`[data-open="${focusedCard}"]`)?.focus();
}
function setFilter(value) { filter = value; selected.clear(); selecting = false; render(); }
function edit(id, focus = false) {
  if (active !== id) { draftTaskId = null; reordering = false; $('new-task').value = ''; }
  active = id; const n = book.state.notes[id]; if (!n) return; editorVersion = JSON.stringify(payload(n));
  if (draftTaskId) {
    const draft = n.tasks.find(t => t.id === draftTaskId);
    if (draft) $('new-task').value = draft.text;
    else { draftTaskId = null; $('new-task').value = ''; }
  }
  $('editor').dataset.color = n.color;
  $('note-title').value = n.title; $('note-body').value = n.body; $('note-folder').value = n.folder; $('note-type').value = n.type;
  $('pin-note').classList.toggle('pinned', n.pinned); $('pin-note').setAttribute('aria-label', n.pinned ? 'Unpin note' : 'Pin note');
  $('pin-note').title = n.pinned ? 'Unpin note' : 'Pin note';
  $('pin-note').hidden = n.trashed; $('trash-preview-label').hidden = !n.trashed;
  for (const id of ['note-title','note-body','note-folder']) $(id).readOnly = n.trashed;
  $('note-type').disabled = n.trashed;
  $('color-picker').innerHTML = colors.map(c => `<button class="color-choice" data-color="${c}" data-selected="${n.color === c}" aria-label="${c} note color"></button>`).join('');
  renderTasks(); renderEditorMeta();
  $('editor-status').textContent = book.loadError ? 'Notebook recovery needed' : 'Saved on this device';
  if (!$('editor').open) $('editor').showModal();
  resizeEditorFields();
  if (focus) $('note-title').focus();
}
function renderTasks() {
  taskDrag?.cancel();
  const n = book.state.notes[active]; if (!n) return;
  $('note-body').hidden = n.type === 'task'; $('checklist').hidden = n.type !== 'task'; $('add-task-form').hidden = n.type !== 'task' || n.trashed;
  $('task-tools').hidden = n.type !== 'task' || n.trashed;
  $('task-order-info').textContent = n.taskOrder?.ids.length ? 'Custom order · new items at bottom' : 'Oldest first · newest at bottom';
  $('reorder-tasks').innerHTML = icon('reorder') + (reordering ? 'Hide times' : 'Show times');
  $('reorder-tasks').setAttribute('aria-pressed', String(reordering)); $('reset-task-order').disabled = !n.taskOrder?.ids.length;
  const row = t => `<div class="task-row ${t.done ? 'done' : ''}" data-task="${escape(t.id)}">${n.trashed ? '' : `<button class="icon-button task-drag-handle" data-drag-task="${escape(t.id)}" aria-label="Drag to reorder: ${escape(t.text || 'Empty item')}" aria-describedby="task-drag-help" aria-pressed="false" title="Drag to reorder. Keyboard: Alt+Up/Down or arrow keys on this handle.">${icon('grip')}</button>`}<input type="checkbox" ${t.done ? 'checked' : ''} ${n.trashed ? 'disabled' : ''} aria-label="${t.done ? 'Mark incomplete' : 'Mark complete'}: ${escape(t.text || 'Empty item')}"><div class="task-content"><textarea class="task-text" rows="1" wrap="soft" aria-label="Checklist item" maxlength="2000" ${n.trashed ? 'readonly' : ''}></textarea><span class="task-added" ${reordering ? '' : 'hidden'}>${t.createdAt === undefined ? 'Added before time tracking' : 'Added ' + escape(dateTime(t.createdAt))}</span></div>${n.trashed ? '' : `<button class="icon-button" data-remove-task="${escape(t.id)}" aria-label="Remove item" title="Remove item">${icon('close')}</button>`}</div>`;
  const visibleTasks = n.tasks.filter(t => t.id !== draftTaskId);
  const group = (id, tasks) => {
    $(id).innerHTML = tasks.map(row).join('');
    tasks.forEach((task, index) => { $(id).children[index].querySelector('textarea').value = task.text; });
  };
  group('checklist', visibleTasks.filter(t => !t.done));
  group('completed-checklist', visibleTasks.filter(t => t.done));
  $('completed-count').textContent = n.tasks.filter(t => t.done).length;
  $('completed-section').hidden = n.type !== 'task' || !n.tasks.some(t => t.done);
  resizeEditorFields();
}
function resizeField(field) {
  if (!field || field.tagName !== 'TEXTAREA' || field.id === 'note-body' || !field.getClientRects().length) return;
  field.style.height = 'auto'; field.style.height = (field.scrollHeight + field.offsetHeight - field.clientHeight) + 'px';
}
function resizeEditorFields() { for (const field of $('editor').querySelectorAll('textarea')) resizeField(field); }
function renderEditorMeta() {
  const n = book.state.notes[active]; if (!n) return;
  $('note-date').textContent = `Created ${dateTime(n.createdAt)} · Edited ${dateTime(n.updatedAt)}`;
  const text = n.title + ' ' + (n.type === 'task' ? n.tasks.map(t => t.text).join(' ') : n.body);
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  $('word-count').textContent = `${count} word${count === 1 ? '' : 's'}`;
}
function update(fields) { return safely(() => { if (book.state.notes[active]?.trashed) return; book.update(active, fields); editorVersion = JSON.stringify(payload(book.state.notes[active])); $('editor-status').textContent = 'Saved on this device'; renderEditorMeta(); return true; }); }
function newNote() { if (!flushEditor()) return; safely(() => { const n = book.create(filter === 'tasks' ? 'task' : 'note', { folder: filter.startsWith('folder:') ? filter.slice(7) : '' }); edit(n.id, true); }); }
function saveTaskDraft() {
  const n = book.state.notes[active]; if (!n || n.trashed || n.type !== 'task') return true;
  const text = $('new-task').value;
  if (!text.trim()) {
    if (!draftTaskId) return true;
    if (!update({ tasks: n.tasks.filter(t => t.id !== draftTaskId) })) return false;
    draftTaskId = null; return true;
  }
  if (!draftTaskId) draftTaskId = crypto.randomUUID();
  const existing = n.tasks.find(t => t.id === draftTaskId);
  if (existing?.text === text) return !book.saveError || !!update({ tasks: n.tasks });
  const tasks = existing ? n.tasks.map(t => t.id === draftTaskId ? { ...t, text } : t) : [...n.tasks, { id: draftTaskId, text, done: false }];
  return !!update({ tasks });
}
function commitTaskDraft() {
  if (!$('new-task').value.trim() || !saveTaskDraft()) return;
  draftTaskId = null; $('new-task').value = ''; renderTasks(); $('new-task').focus();
}
function closeEditor() {
  taskDrag?.cancel();
  if (composing) return;
  if (!flushEditor()) return;
  $('editor').close(); active = null; draftTaskId = null; $('new-task').value = ''; render(); engine.run();
}
function flushEditor() {
  const n = book.state.notes[active];
  if (!n || n.trashed) return true;
  try {
    if (!saveTaskDraft()) return false;
    const fields = { title: $('note-title').value, body: $('note-body').value, folder: $('note-folder').value.trim() };
    if (Object.entries(fields).some(([key,value]) => n[key] !== value)) book.update(active, fields); else book.save();
    return true;
  } catch (error) { $('editor-status').textContent = 'Save failed — keep this note open'; toast('Could not save. ' + error.message, true); return false; }
}
function moveToTrash(ids, trashed) {
  safely(() => { book.batchTrash(ids, trashed); selected.clear(); render(); engine.run(); toast(trashed ? 'Moved to Trash.' : 'Notes restored.'); });
}
function askDelete(ids) {
  deleteIds = ids.filter(id => book.state.notes[id]?.trashed); if (!deleteIds.length) return;
  if (book.state.config && !(book.state.serverFeatures?.server === book.state.config.server && book.state.serverFeatures?.permanentDelete)) {
    toast('Update the hosting app to NoteMark 1.1 and sync once before permanent deletion.', true); engine.run(); return;
  }
  $('delete-message').textContent = `Permanently delete ${deleteIds.length} ${deleteIds.length === 1 ? 'note' : 'notes'} from this notebook?`;
  $('delete-dialog').showModal(); $('cancel-delete').focus();
}
function showSettings() {
  renderConnection(); $('pairing-panel').hidden = true; $('settings-message').textContent = ''; $('settings-dialog').showModal();
  if (book.loadError) message(book.loadError.message, true);
  if (window.miraDesktop?.getInfo) window.miraDesktop.getInfo().then(info => { desktopInfo = info; renderConnection(); }).catch(() => {});
  if (androidNative) refreshPhoneInfo().catch(e => message(e.message, true));
}
function message(text, error = false) { $('settings-message').textContent = text; $('settings-message').classList.toggle('error', error); }
async function refreshPhoneInfo() {
  const config = book.state.config;
  phoneInfo = await nativeCall('host-info', { id: config?.id, token: config?.token });
  if (phoneInfo.running) securePhoneHost(phoneInfo);
  const currentAddress = phoneInfo.urls?.includes(config?.server) ? config.server : phoneInfo.urls?.[0];
  if (phoneInfo.running && phoneInfo.ownsNotebook && config && currentAddress && (config.server !== currentAddress || config.fingerprint !== phoneInfo.fingerprint?.toUpperCase())) {
    // Change the advertised address without resetting revisions or duplicating the notebook.
    book.state.config = { ...config, server: normalizeServer(currentAddress), fingerprint: phoneInfo.fingerprint.toUpperCase() }; book.save();
    $('pairing-panel').hidden = true;
    message('The phone’s Wi-Fi address changed. Copy its new connection code into Windows.');
  }
  renderConnection(); return phoneInfo;
}
function securePhoneHost(info) {
  if (!info?.running || info.scheme !== 'https' || !/^[a-f\d]{64}$/i.test(info.fingerprint || '') ||
      !Array.isArray(info.urls) || info.urls.some(url => !url.startsWith('https://')))
    throw new Error('Secure phone sync could not start. Reopen NoteMark and try again.');
  return info;
}
function renderConnection() {
  const c = book.state.config;
  $('connection-summary').innerHTML = c ? `<strong>${icon(engine.status === 'offline' ? 'sync' : 'check')}${engine.status === 'offline' ? 'Notebook linked · waiting for a connection' : 'Your notebook is linked'}</strong><span>${escape(c.server)}</span><p>${engine.status === 'offline' ? escape(lastError) : book.state.lastSync ? 'Last synced ' + new Date(book.state.lastSync).toLocaleTimeString() : 'Ready for your first sync'}</p><button id="show-pairing">Show connection code</button><button id="sync-now">Sync now</button><button id="disconnect">Disconnect</button>` : '<strong>One notebook. All your devices.</strong><p>Start a notebook on a sync server, then connect your other device with a private connection code.</p>';
  if (c) $('server-url').value = c.server;
  $('lan-options').replaceChildren();
  if (desktopInfo?.urls?.length) {
    for (const url of desktopInfo.urls) {
      const b = document.createElement('button'); b.textContent = 'Use Windows Wi-Fi server · ' + url; b.addEventListener('click', () => $('server-url').value = url); $('lan-options').append(b);
    }
    if (!c && !$('server-url').value) $('server-url').value = desktopInfo.urls[0];
  }
  if (desktopInfo?.error) message(desktopInfo.error, true);
  $('phone-host').hidden = !androidNative;
  if (androidNative) {
    $('phone-host-status').textContent = phoneInfo?.error || (phoneInfo?.running ? `Phone server is on${phoneInfo.urls[0] ? ' · ' + phoneInfo.urls[0] : ' · reconnect this phone to Wi-Fi'}. On Windows, choose Connect a device and use this phone’s code.` : 'Start here on Android, then connect from Windows. Your existing notes will be kept.');
    $('start-phone-host').innerHTML = (phoneInfo?.ownsNotebook ? 'Show phone connection code' : 'Host from this phone') + icon('arrow');
    $('stop-phone-host').hidden = !phoneInfo?.running;
  }
  const wifi = desktopInfo?.wifi;
  $('windows-wifi').hidden = !wifi;
  if (wifi) {
    $('wifi-status').textContent = wifi.allowed ? 'Windows Wi-Fi access is enabled' : 'Wi-Fi access needs Windows approval';
    $('wifi-help').textContent = wifi.allowed ? 'Devices on your local network can reach this PC while NoteMark is open.' : wifi.blocked ? 'A Windows firewall block rule is active for this app. Run Setup.exe and use the installed app, then test the connection again.' : 'Windows can block the phone even when this PC syncs successfully. Repair Wi-Fi access to allow this app on your local network. Windows will ask for administrator approval.';
    if (wifi.temporaryLocation) $('wifi-help').textContent += ' This copy is running from a temporary archive folder. Install Setup.exe for a permanent location.';
    $('repair-wifi').hidden = wifi.allowed;
  }
}
async function connectionAction(button, fn) {
  if (connecting) { message('Please wait for the current connection to finish.'); return; }
  if (book.state.config && !confirm('Connect to another notebook? Your current notes stay on this device and will be added to that notebook. Export a backup first if you want to keep them separate.')) return;
  connecting = true; button.disabled = true; message('Connecting…');
  const idle = engine.pause();
  try { await idle; const c = await fn(); book.attach(c); renderConnection(); showPairing(); message('Connected. Your notes will appear on your paired devices.'); engine.resume(); await engine.run(); return true; }
  catch (e) { message('Could not connect. ' + e.message, true); return false; }
  finally { engine.resume(); connecting = false; button.disabled = false; }
}
function showPairing() {
  const c = book.state.config; if (!c) return;
  $('pairing-output').value = pairingCode(c); $('pairing-panel').hidden = false;
}
async function saveDownload(bytes, mime, name) {
  if (androidNative) {
    const { transfer } = await nativeCall('export-start', { name, mime });
    try {
      for (let offset = 0, sequence = 0; offset < bytes.length; offset += 64 * 1024, sequence++) {
        const part = bytes.subarray(offset, offset + 64 * 1024); let text = '';
        for (let i = 0; i < part.length; i += 8192) text += String.fromCharCode(...part.subarray(i, i + 8192));
        await nativeCall('export-chunk', { transfer, sequence, data: btoa(text) });
      }
      await nativeCall('export-finish', { transfer });
    } catch (error) { nativeCall('export-cancel', { transfer }).catch(() => {}); throw error; }
  } else {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
async function exportBackup() {
  const b = $('export-notes'); b.disabled = true;
  try { await saveDownload(await createBackup(book), 'application/zip', backupFilename()); toast(androidNative ? 'Choose where to save your backup.' : 'ZIP backup downloaded.'); }
  catch (error) { toast(error.message, true); } finally { b.disabled = false; }
}
async function exportRecovery() {
  const text = book.loadError ? book.storage.getItem('mira.notes.v1') : book.export();
  try { await saveDownload(new TextEncoder().encode(text), 'application/json', `NoteMark-recovery-${new Date().toISOString().slice(0, 10)}.json`); }
  catch (error) { toast(error.message, true); }
}
function reflectSync({ status, message: msg }) {
  lastError = msg || ''; $('sync-status').dataset.state = status;
  const labels = { synced: 'All thoughts in sync', pending: 'Changes waiting to sync', syncing: 'Bringing things together…', offline: 'Offline · saved on device', local: 'Saved on this device' };
  $('sync-label').textContent = book.saveError ? 'Storage full · export a backup' : labels[status] || labels.local;
  $('sync-status').title = msg || 'Settings & sync';
  if ($('settings-dialog').open) renderConnection();
}
$('today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
for (const id of ['new-note', 'empty-create']) $(id).addEventListener('click', newNote);
for (const id of ['settings', 'mobile-settings', 'sync-status', 'connect-sidebar']) $(id).addEventListener('click', showSettings);
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); setFilter('all'); });
$('mobile-home').addEventListener('click', () => setFilter('all'));
document.querySelectorAll('#navigation [data-filter]').forEach(el => el.addEventListener('click', () => setFilter(el.dataset.filter)));
$('mobile-filters').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (b) setFilter(b.dataset.filter); });
$('folders').addEventListener('click', e => { const b = e.target.closest('[data-folder]'); if (b) setFilter('folder:' + b.dataset.folder); });
$('new-folder').addEventListener('click', () => { $('folder-name').value = ''; $('folder-dialog').showModal(); });
$('folder-form').addEventListener('submit', e => { e.preventDefault(); const f = $('folder-name').value.trim(); if (!f) return; safely(() => book.addFolder(f)); $('folder-dialog').close(); setFilter('folder:' + f); });
$('notes-grid').addEventListener('click', e => {
  const restore = e.target.closest('[data-restore]'); if (restore) return moveToTrash([restore.dataset.restore], false);
  const del = e.target.closest('[data-delete]'); if (del) return askDelete([del.dataset.delete]);
  if (e.target.closest('.card-selector')) return;
  const b = e.target.closest('[data-open]'); if (!b) return;
  if (selecting) { selected.has(b.dataset.open) ? selected.delete(b.dataset.open) : selected.add(b.dataset.open); render(); } else edit(b.dataset.open);
});
$('notes-grid').addEventListener('change', e => { const id = e.target.dataset.select; if (!id) return; selecting = true; e.target.checked ? selected.add(id) : selected.delete(id); render(); document.querySelector(`[data-select="${id}"]`)?.focus(); });
$('select-mode').addEventListener('click', () => { selecting = !selecting; selected.clear(); render(); });
$('select-all').addEventListener('change', e => { selected = new Set(e.target.checked ? visibleIds : []); render(); });
$('selection-trash').addEventListener('click', () => moveToTrash([...selected], true));
$('selection-restore').addEventListener('click', () => moveToTrash([...selected], false));
$('selection-delete').addEventListener('click', () => askDelete([...selected]));
$('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
$('confirm-delete').addEventListener('click', () => { try { book.permanentlyDelete(deleteIds); selected.clear(); $('delete-dialog').close(); render(); engine.run(); toast('Notes permanently deleted.'); } catch (e) { toast(e.message, true); } });
$('search').addEventListener('input', e => { search = e.target.value; render(); });
$('sort').addEventListener('change', () => { try { localStorage.setItem('notemark.sort.v1', $('sort').value); } catch { toast('Could not save the sort preference.', true); } render(); });
$('layout-toggle').addEventListener('click', () => { const on = $('notes-grid').classList.toggle('list'); $('layout-toggle').innerHTML = icon(on ? 'grid' : 'list'); $('layout-toggle').setAttribute('aria-label', on ? 'Switch to grid view' : 'Switch to list view'); $('layout-toggle').title = on ? 'Switch to grid view' : 'Switch to list view'; });
$('close-editor').addEventListener('click', closeEditor);
$('editor').addEventListener('cancel', e => { e.preventDefault(); closeEditor(); });
$('editor').addEventListener('compositionstart', () => composing = true);
$('editor').addEventListener('compositionend', () => composing = false);
const outsideEditor = e => { const r = $('editor').getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
$('editor').addEventListener('pointerdown', e => { outsideDown = e.target === $('editor') && outsideEditor(e); });
$('editor').addEventListener('pointerup', e => { if (outsideDown && outsideEditor(e) && matchMedia('(min-width: 761px) and (pointer: fine)').matches) closeEditor(); outsideDown = false; });
$('editor').addEventListener('pointercancel', () => outsideDown = false);
$('note-title').addEventListener('input', e => { resizeField(e.target); update({ title: e.target.value }); });
$('note-body').addEventListener('input', e => update({ body: e.target.value }));
$('note-folder').addEventListener('input', e => update({ folder: e.target.value.trim() }));
$('note-type').addEventListener('change', e => { if (!flushEditor()) { e.target.value = book.state.notes[active].type; return; } draftTaskId = null; $('new-task').value = ''; update({ type: e.target.value }); renderTasks(); });
$('pin-note').addEventListener('click', () => { update({ pinned: !book.state.notes[active].pinned }); const n = book.state.notes[active]; $('pin-note').classList.toggle('pinned', n.pinned); $('pin-note').setAttribute('aria-label', n.pinned ? 'Unpin note' : 'Pin note'); $('pin-note').title = n.pinned ? 'Unpin note' : 'Pin note'; });
$('color-picker').addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b && !book.state.notes[active]?.trashed) { update({ color: b.dataset.color }); $('editor').dataset.color = b.dataset.color; for (const el of $('color-picker').children) el.dataset.selected = String(el === b); } });
function taskInput(e) {
  const row = e.target.closest('[data-task]'); if (!row) return;
  const editor = $('editor'), scrollTop = editor.scrollTop, scrollLeft = editor.scrollLeft;
  resizeField(e.target);
  const key = e.target.type === 'checkbox' ? 'done' : 'text', value = key === 'done' ? e.target.checked : e.target.value;
  update({ tasks: book.state.notes[active].tasks.map(t => t.id === row.dataset.task ? { ...t, [key]: value } : t) });
  if (key === 'done') {
    renderTasks(); const next = [...document.querySelectorAll('#editor [data-task]')].find(el => el.dataset.task === row.dataset.task);
    // The item changes sections, but focusing it must not follow it down the list.
    next?.querySelector('input[type=checkbox]')?.focus({ preventScroll: true });
    editor.scrollTop = scrollTop; editor.scrollLeft = scrollLeft;
  }
}
for (const id of ['checklist','completed-checklist']) {
  $(id).addEventListener('input', taskInput);
  $(id).addEventListener('click', e => { const b = e.target.closest('[data-remove-task]'); if (b) { update({ tasks: book.state.notes[active].tasks.filter(t => t.id !== b.dataset.removeTask) }); renderTasks(); } });
  $(id).addEventListener('keydown', e => { if ((e.altKey || e.target.closest('[data-drag-task]')) && ['ArrowUp','ArrowDown'].includes(e.key) && !e.isComposing) { const row = e.target.closest('[data-task]'); if (row) { e.preventDefault(); moveChecklistTask(row.dataset.task, e.key === 'ArrowUp' ? -1 : 1, !!e.target.closest('[data-drag-task]')); } } });
}
function orderSaved(id, handle = true) {
  editorVersion = JSON.stringify(payload(book.state.notes[active])); renderTasks(); renderEditorMeta();
  $('editor-status').textContent = 'Order saved on this device';
  [...$('editor').querySelectorAll('[data-task]')].find(row => row.dataset.task === id)?.querySelector(handle ? '[data-drag-task]' : 'textarea')?.focus({ preventScroll: true });
  $('task-drag-status').textContent = 'Item moved. Order saved.';
}
taskDrag = checklistDrag($('editor'), {
  prepare: () => !composing && !!book.state.notes[active] && !book.state.notes[active].trashed && flushEditor(),
  drop: (id, target, after) => {
    const saved = safely(() => { if (book.placeTask(active, id, target, after)) orderSaved(id); else $('task-drag-status').textContent = 'Order unchanged.'; return true; });
    if (!saved) $('task-drag-status').textContent = 'Could not save the order. Original order kept.';
  },
  announce: text => { $('task-drag-status').textContent = text; }
});
function moveChecklistTask(id, direction, handle = false) {
  if (!flushEditor()) return;
  safely(() => { if (book.moveTask(active, id, direction)) orderSaved(id, handle); });
}
$('reorder-tasks').addEventListener('click', () => { if (!flushEditor()) return; commitTaskDraft(); reordering = !reordering; renderTasks(); });
$('reset-task-order').addEventListener('click', () => { if (!flushEditor()) return; safely(() => { book.resetTaskOrder(active); reordering = false; editorVersion = JSON.stringify(payload(book.state.notes[active])); renderTasks(); }); });
$('new-task').addEventListener('input', e => { resizeField(e.target); saveTaskDraft(); });
$('new-task').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing) { e.preventDefault(); commitTaskDraft(); } });
$('add-task-form').addEventListener('submit', e => { e.preventDefault(); commitTaskDraft(); });
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).close()));
for (const [tab, other, panel, otherPanel] of [['tab-create', 'tab-join', 'create-panel', 'join-panel'], ['tab-join', 'tab-create', 'join-panel', 'create-panel']]) $(tab).addEventListener('click', () => { $(tab).classList.add('active'); $(other).classList.remove('active'); $(panel).hidden = false; $(otherPanel).hidden = true; message(''); });
$('create-sync').addEventListener('click', () => connectionAction($('create-sync'), () => createVault($('server-url').value)));
$('join-sync').addEventListener('click', () => connectionAction($('join-sync'), async () => { const c = parsePairing($('pairing-input').value); await checkVault(c); return c; }));
$('start-phone-host').addEventListener('click', async () => {
  const button = $('start-phone-host');
  if (engine.busy || connecting) return message('Please wait for the current sync to finish.');
  if (phoneInfo?.ownsNotebook && book.state.config) {
    button.disabled = true;
    try {
      await nativeCall('host-start'); await refreshPhoneInfo(); showPairing();
      message('On Windows, open Settings & sync → Connect a device and paste this phone’s code. Keep NoteMark open on the phone.');
      await engine.run();
    } catch (e) { message(e.message, true); } finally { button.disabled = false; }
    return;
  }
  const connected = await connectionAction(button, async () => {
    phoneInfo = securePhoneHost(await nativeCall('host-start'));
    if (!phoneInfo.urls.length) throw new Error('Connect this phone to Wi-Fi and try again.');
    const config = await createVault(phoneInfo.loopback);
    phoneInfo.ownsNotebook = true;
    return { ...config, server: phoneInfo.urls[0], fingerprint: phoneInfo.fingerprint.toUpperCase() };
  });
  if (connected) message('Phone notebook ready. On Windows, choose Connect a device and paste this phone’s new code. Keep NoteMark open on the phone.');
});
$('stop-phone-host').addEventListener('click', async () => {
  if (engine.busy || connecting) return message('Please wait for the current sync to finish.');
  if (!confirm('Stop phone hosting? Your notes stay saved. Paired devices can sync again when you restart hosting.')) return;
  try { await nativeCall('host-stop'); await refreshPhoneInfo(); message('Phone hosting stopped. Your notes are saved on this device.'); }
  catch (e) { message(e.message, true); }
});
$('repair-wifi').addEventListener('click', async () => {
  const b = $('repair-wifi'); b.disabled = true; message('Approve the Windows administrator prompt to enable Wi-Fi sync.');
  try { const wifi = await window.miraDesktop.repairWifi(); desktopInfo = { ...desktopInfo, wifi }; renderConnection(); message(wifi.allowed ? 'Windows Wi-Fi access is enabled. Retry Connect this device on your phone.' : 'Wi-Fi access still appears blocked. Run Setup.exe and use the installed copy.', !wifi.allowed); }
  catch { message('Windows approval was cancelled or Wi-Fi access could not be enabled. Run Setup.exe as administrator and try again.', true); }
  finally { b.disabled = false; }
});
$('test-connection').addEventListener('click', async () => {
  const b = $('test-connection'); b.disabled = true; message('Checking whether the sync server can be reached…');
  try {
    const code = !$('join-panel').hidden ? parsePairing($('pairing-input').value) : book.state.config;
    const entered = !$('join-panel').hidden ? code?.server : $('server-url').value || code?.server;
    if (!entered) throw new Error('Enter a server address or paste your connection code first.');
    const server = normalizeServer(entered);
    $('open-connection-test').href = server + '/api/health'; $('open-connection-test').hidden = !!code?.fingerprint;
    await probeServer(server, code?.server === server ? code : {}); message('The NoteMark server is reachable from this device. You can connect now.');
  } catch (error) { message(error.message, true); }
  finally { b.disabled = false; }
});
$('connection-summary').addEventListener('click', e => {
  if (e.target.id === 'show-pairing') showPairing();
  if (e.target.id === 'sync-now') engine.run();
  if (e.target.id === 'disconnect') {
    if (engine.busy) return message('Please wait for the current sync to finish.');
    if (!confirm('Disconnect this device? Save your connection code first so you can reconnect. Your notes stay on this device.')) return;
    safely(() => { book.state.config = null; book.save(); }); $('pairing-output').value = ''; $('pairing-panel').hidden = true; reflectSync({ status: 'local' }); renderConnection(); message('Disconnected. Your notes are still saved on this device.');
  }
});
$('copy-pairing').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('pairing-output').value); toast('Private connection code copied.'); } catch { $('pairing-output').focus(); $('pairing-output').select(); message('Select and copy the connection code above.'); } });
$('export-notes').addEventListener('click', exportBackup);
$('export-recovery').addEventListener('click', exportRecovery);
$('import-notes').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try { if (file.size > MAX_ARCHIVE) throw new Error('Choose a backup smaller than 64 MB.'); const data = await readBackup(new Uint8Array(await file.arrayBuffer()), file.name); const count = book.import(data); toast(`${count} notes restored as new copies.`); render(); engine.run(); }
  catch (error) { toast(error.message, true); } finally { e.target.value = ''; }
});
book.addEventListener('change', () => { render(); if (book.state.config) engine.emit('pending'); });
book.addEventListener('remote', () => {
  render();
  if (active && !book.state.notes[active]) { $('editor').close(); active = null; toast('This note was permanently deleted on another device.'); return; }
  if (active && book.state.notes[active] && !book.state.notes[active].dirty) {
    const n = book.state.notes[active];
    if (JSON.stringify(payload(n)) !== editorVersion) {
      const focused = document.activeElement, field = focused?.id, taskFocus = focused?.closest('[data-task]')?.dataset.task, checkboxFocus = focused?.type === 'checkbox', start = focused?.selectionStart, end = focused?.selectionEnd;
      edit(active);
      const restored = field && $(field) || (taskFocus && [...$('editor').querySelectorAll('[data-task]')].find(row => row.dataset.task === taskFocus)?.querySelector(checkboxFocus ? 'input[type=checkbox]' : 'textarea'));
      if (restored) { restored.focus({ preventScroll: true }); if (typeof start === 'number' && restored.setSelectionRange && !checkboxFocus) restored.setSelectionRange(start, end); }
    }
  }
});
book.addEventListener('conflict', e => { if (active === e.detail.original) edit(e.detail.copy); toast('Both edits kept. Your version is saved as a conflict copy.'); });
engine.addEventListener('status', e => reflectSync(e.detail));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!$('editor').open && !$('settings-dialog').open) $('search').focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!$('settings-dialog').open) newNote(); }
});
window.addEventListener('mira-back', e => { const d = [...document.querySelectorAll('dialog[open]')].at(-1); if (d) { e.preventDefault(); if (d.id === 'editor') closeEditor(); else d.close(); } });
window.addEventListener('online', () => engine.run());
window.addEventListener('pagehide', flushEditor);
window.addEventListener('mira-save', flushEditor);
window.addEventListener('beforeunload', e => { if (!flushEditor()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushEditor(); else engine.run(); });
window.addEventListener('resize', resizeEditorFields);
window.visualViewport?.addEventListener('resize', resizeEditorFields);
// Windows keeps syncing while minimized or covered; Android follows visibility.
setInterval(() => { if (desktopNative || !document.hidden) engine.run(); }, 3000);
render();
if (book.loadError) { toast(book.loadError.message, true); $('new-note').disabled = true; $('empty-create').disabled = true; $('export-notes').disabled = true; $('export-recovery').hidden = false; }
if (window.miraDesktop?.getInfo) { try { desktopInfo = await window.miraDesktop.getInfo(); } catch { /* Local notes remain available if LAN hosting cannot start. */ } }
if (androidNative) { try { await refreshPhoneInfo(); } catch { /* Offline writing remains available. */ } }
engine.run();
