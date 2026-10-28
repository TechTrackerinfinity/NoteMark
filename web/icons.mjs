const paths = {
  grip: '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  reorder: '<path d="M9 5h12M9 12h12M9 19h12M3 4v4m-2-2 2-2 2 2M3 20v-4m-2 2 2 2 2-2"/>',
  notes: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  pin: '<path d="m16 3 5 5-4 2-3 5-2-2-5 5-1-1 5-5-2-2 5-3zM6 18l-3 3"/>',
  tasks: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="m6 9 1.5 1.5L10 8m-4 7 1.5 1.5L10 14m3-5h5m-5 6h5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14M10 10v6m4-6v6"/>',
  restore: '<path d="M3 10h5V5M4 9a8 8 0 1 1-1 7M12 8v5l3 2"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14m-9 5 4 4m0-4-4 4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  settings: '<path d="m9 3-.7 2.3-2.3 1-.2 2.4L3 10v4l2.8 1.3.2 2.4 2.3 1L9 21h6l.7-2.3 2.3-1 .2-2.4L21 14v-4l-2.8-1.3-.2-2.4-2.3-1L15 3z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  back: '<path d="m12 5-7 7 7 7M5 12h15"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  select: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7 12 3 3 7-7"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  sync: '<path d="M20 7v5h-5M4 17v-5h5M5.3 7a8 8 0 0 1 13.2-2L20 7M4 17l1.5 2A8 8 0 0 0 18.7 17"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  devices: '<rect x="2" y="4" width="13" height="11" rx="2"/><path d="M8 15v4M4 19h8"/><rect x="17" y="8" width="5" height="13" rx="1.5"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-1-10 6 6 0 0 1 11-2 6 6 0 0 1 1 12z"/>',
};
export function icon(name, cls = '') { return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.notes}</svg>`; }
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  root.querySelectorAll('button[aria-label]').forEach(el => { el.title = el.getAttribute('aria-label'); });
}
