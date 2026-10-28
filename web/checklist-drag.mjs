// Pointer Events work for both mouse and Android touch without blocking text scrolling.
export function checklistDrag(editor, { prepare, drop, announce }) {
  let drag = null, frame = 0;
  const cancel = () => {
    if (!drag) return;
    const previous = drag; drag = null;
    cancelAnimationFrame(frame); frame = 0;
    previous.row.classList.remove('task-drag-source');
    previous.handle.setAttribute('aria-pressed', 'false');
    previous.ghost?.remove(); previous.marker?.remove();
    editor.classList.remove('task-dragging');
    if (editor.hasPointerCapture(previous.pointerId)) editor.releasePointerCapture(previous.pointerId);
  };
  function locate() {
    const d = drag, bounds = editor.getBoundingClientRect(), group = d.group.getBoundingClientRect();
    d.target = null; d.marker.hidden = true;
    if (d.x < bounds.left || d.x > bounds.right || d.y < bounds.top || d.y > bounds.bottom || d.y < group.top - 20 || d.y > group.bottom + 20) return;
    const rows = [...d.group.querySelectorAll('[data-task]')].filter(row => row !== d.row);
    const next = rows.find(row => { const r = row.getBoundingClientRect(); return d.y < r.top + r.height / 2; });
    const target = next || rows.at(-1); if (!target) return;
    d.target = { id: target.dataset.task, after: !next };
    const r = target.getBoundingClientRect(), y = next ? r.top : r.bottom;
    if (y < bounds.top || y > bounds.bottom) return;
    d.marker.hidden = false;
    Object.assign(d.marker.style, { left: (group.left + 4) + 'px', top: (y - 2) + 'px', width: Math.max(0, group.width - 8) + 'px' });
  }
  function tick() {
    if (!drag?.started) return;
    const d = drag, r = editor.getBoundingClientRect(), now = performance.now();
    const elapsed = Math.min(32, now - d.lastFrame); d.lastFrame = now;
    if (d.x >= r.left && d.x <= r.right && d.y >= r.top && d.y <= r.bottom) {
      const edge = Math.min(64, r.height / 5);
      const speed = d.y < r.top + edge ? -Math.min(1, (r.top + edge - d.y) / edge) : d.y > r.bottom - edge ? Math.min(1, (d.y - r.bottom + edge) / edge) : 0;
      const g = d.group.getBoundingClientRect(), delta = speed * elapsed * 0.65;
      // Stop at this section's end rather than scrolling past it into the add field.
      editor.scrollTop += delta > 0 ? Math.min(delta, Math.max(0, g.bottom - d.y + 12)) : Math.max(delta, Math.min(0, g.top - d.y - 12));
    }
    locate(); frame = requestAnimationFrame(tick);
  }
  editor.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-drag-task]');
    if (!handle || !e.isPrimary || e.button !== 0 || drag || !prepare()) return;
    e.preventDefault(); handle.focus({ preventScroll: true });
    const row = handle.closest('[data-task]');
    drag = { pointerId: e.pointerId, handle, row, group: row.parentElement, id: row.dataset.task, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, started: false };
    editor.setPointerCapture(e.pointerId);
  });
  editor.addEventListener('pointermove', e => {
    const d = drag; if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.started && Math.hypot(d.x - d.startX, d.y - d.startY) < 6) return;
    e.preventDefault();
    if (!d.started) {
      d.started = true; d.lastFrame = performance.now();
      d.handle.setAttribute('aria-pressed', 'true'); d.row.classList.add('task-drag-source'); editor.classList.add('task-dragging');
      d.ghost = document.createElement('div'); d.ghost.className = 'task-drag-ghost'; d.ghost.setAttribute('aria-hidden', 'true');
      d.ghost.textContent = d.row.querySelector('textarea').value || 'Empty item';
      d.ghost.style.width = Math.min(d.group.clientWidth - 16, 420) + 'px';
      d.marker = document.createElement('div'); d.marker.className = 'task-drop-marker'; d.marker.setAttribute('aria-hidden', 'true');
      // Keep feedback inside the modal top layer so it appears above the editor.
      editor.append(d.ghost, d.marker); tick();
      announce('Dragging item. Drop within this section. Escape cancels.');
    }
    const r = editor.getBoundingClientRect(), width = parseFloat(d.ghost.style.width);
    Object.assign(d.ghost.style, { left: Math.max(r.left + 8, Math.min(d.x - 30, r.right - width - 8)) + 'px', top: Math.max(r.top + 8, Math.min(d.y - 58, r.bottom - 54)) + 'px' });
    locate();
  });
  editor.addEventListener('pointerup', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.started) locate();
    const { started, id, target } = drag;
    cancel();
    if (started) { e.preventDefault(); if (target) drop(id, target.id, target.after); else announce('Reorder cancelled.'); }
  });
  editor.addEventListener('pointercancel', cancel);
  editor.addEventListener('lostpointercapture', cancel);
  editor.addEventListener('close', cancel);
  document.addEventListener('keydown', e => { if (drag && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); announce('Reorder cancelled.'); } }, true);
  window.addEventListener('blur', cancel);
  window.addEventListener('pagehide', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { cancel };
}
