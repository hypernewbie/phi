import type { RailProfile, RailState } from './electron.js';

/** Uppercased observed hostname with .local, scheme and explicit port stripped (IPv6 colons kept). */
export function canonicalHostname(raw: string): string {
  let s = (raw ?? '').trim().toUpperCase();
  s = s.replace(/\.LOCAL\.?$/, '');
  s = s.replace(/^[A-Z][A-Z0-9+.-]*:\/\//, '');
  const portTail = /^\[?([^:[\]]+):\d+$/.exec(s);
  if (portTail) s = portTail[1];
  return s;
}

/** Display identity: the canonical hostname when observed, else the profile name. */
export function identityLabel(profile: RailProfile): string {
  const canonical = canonicalHostname(profile.hostname);
  return canonical !== '' ? canonical : profile.name;
}

/* Server-selector glyphs: a single Greek letter derived from a stable
   hash of the canonical hostname, so a saved server keeps its glyph
   across sessions without any manual assignment. Phi (Φ/φ) is excluded
   — the brand mark belongs to the title row, not to a generated glyph. */
const GREEK_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Α', 'α'], ['Β', 'β'], ['Γ', 'γ'], ['Δ', 'δ'], ['Ε', 'ε'], ['Ζ', 'ζ'],
  ['Η', 'η'], ['Θ', 'θ'], ['Ι', 'ι'], ['Κ', 'κ'], ['Λ', 'λ'], ['Μ', 'μ'],
  ['Ν', 'ν'], ['Ξ', 'ξ'], ['Ο', 'ο'], ['Π', 'π'], ['Ρ', 'ρ'], ['Σ', 'σ'],
  ['Τ', 'τ'], ['Υ', 'υ'], ['Χ', 'χ'], ['Ψ', 'ψ'], ['Ω', 'ω'],
];

/** Every uppercase and lowercase Greek letter (Φ/φ excluded) plus final sigma. */
const GREEK_POOL: readonly string[] = GREEK_PAIRS.flatMap(([u, l]) => [u, l]).concat('ς');

/** Case counterpart of a Greek letter for collision disambiguation (ς → Σ). */
const GREEK_CASE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>(GREEK_PAIRS.flatMap(([u, l]) => [[u, l], [l, u]] as const));
  map.set('ς', 'Σ');
  return map;
})();

/** FNV-1a 32-bit over the hostname's code units (hostnames are ASCII). */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A stable Greek letter for a hostname. Collisions resolve to the
 *  case-different letter first, then Greek numeral marks (Αʹ, Αʹʹ, …).
 *  `used` carries the glyphs already shown in the current rail render. */
export function greekGlyphForHostname(hostname: string, used: ReadonlySet<string> = new Set()): string {
  const base = GREEK_POOL[fnv1a(canonicalHostname(hostname)) % GREEK_POOL.length];
  if (!used.has(base)) return base;
  const swapped = GREEK_CASE.get(base);
  if (swapped !== undefined && !used.has(swapped)) return swapped;
  let marks = 1;
  let candidate = `${base}${'ʹ'.repeat(marks)}`;
  while (used.has(candidate) && marks < 8) {
    marks += 1;
    candidate = `${base}${'ʹ'.repeat(marks)}`;
  }
  return candidate;
}

/** Wails railmodel.BadgeText parity: '' at 0, '9+' above 9. */
export function badgeText(n: number): string {
  if (n <= 0) return '';
  return n > 9 ? '9+' : String(n);
}

/**
 * Imperatively re-renders the whole rail list from a rail-state
 * snapshot (no virtual DOM). `list` defaults to the live #rail-list
 * element; tests pass an explicit element from their own document.
 * An open entry context menu is dismissed first (its target may have
 * changed or vanished).
 */
export function render(state: RailState, list: HTMLElement | null = document.getElementById('rail-list')): void {
  closeRailMenu();
  if (list === null) return;
  // Active server accent drives the rail chrome; unobserved keeps the fallback.
  const rail = list.closest('#rail') as HTMLElement | null;
  const active = state.profiles.find((p) => p.id === state.activeId);
  if (rail !== null) {
    if (active?.accent) rail.style.setProperty('--accent', active.accent);
    else rail.style.removeProperty('--accent');
  }
  list.textContent = '';
  // Glyphs already shown in this render; collision resolution picks a
  // case-different letter or a numeral-marked variant rather than
  // repeating a glyph.
  const usedGlyphs = new Set<string>();
  for (const profile of state.profiles) {
    const item = document.createElement('li');
    item.className = 'rail-item';
    item.dataset.id = profile.id;
    item.draggable = true;
    const identity = identityLabel(profile);
    // CPU intensity: the entry's own accent/glow strengthens as its CPU
    // reading rises (0-100; no reading keeps the resting material), and
    // the precise percent rides the accessible labels.
    const cpu =
      typeof profile.cpu === 'number' && Number.isFinite(profile.cpu)
        ? Math.min(100, Math.max(0, profile.cpu))
        : null;
    if (cpu !== null) item.style.setProperty('--entry-cpu', String(cpu));
    const cpuLabel = cpu === null ? '' : ` · CPU ${cpu}%`;
    item.title = `${identity} · ${profile.origin}${cpuLabel}`;
    item.setAttribute('aria-label', `${identity}${cpuLabel}`);
    if (profile.id === state.activeId) {
      item.classList.add('active');
    }
    // Per-entry accent for the hover preview (--entry-accent).
    if (profile.accent) {
      item.style.setProperty('--entry-accent', profile.accent);
    }

    const mono = document.createElement('span');
    mono.className = 'mono';
    const glyph = greekGlyphForHostname(identity, usedGlyphs);
    usedGlyphs.add(glyph);
    mono.textContent = glyph;
    item.appendChild(mono);

    // Health is diegetic: an unreachable server's entry reads as a
    // disabled tile (muted, no accent glow) instead of a status block.
    if (state.health[profile.id] !== 'up') {
      item.classList.add('offline');
    }

    const unread = state.unread[profile.id] ?? 0;
    if (unread > 0 && profile.id !== state.activeId) {
      const attention = document.createElement('span');
      attention.className = 'attention';
      attention.setAttribute('aria-label', 'Terminal done');
      attention.title = 'Terminal done';
      item.appendChild(attention);
    }

    item.addEventListener('click', () => {
      window.electron.postSelectProfile(profile.id);
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openRailMenu(profile, event.clientY);
    });
    list.appendChild(item);
  }
}

let railMenu: HTMLElement | null = null;
let railMenuProfile: RailProfile | null = null;
let railMenuY = 0;
let railMenuClose: (() => void) | null = null;

/** Native DnD cannot read DataTransfer mid-drag, so track the dragged id here. */
let draggedProfileId: string | null = null;

function clearDropIndicator(list: HTMLElement): void {
  for (const el of list.querySelectorAll<HTMLElement>('.rail-item.drop-before, .rail-item.drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

/** Closest rail item to clientY; drop targets include the gaps between entries and the empty list area. */
function nearestItem(list: HTMLElement, clientY: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestDistance = Infinity;
  for (const el of list.querySelectorAll<HTMLElement>('.rail-item')) {
    const rect = el.getBoundingClientRect();
    const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = el;
    }
  }
  return best;
}

/** Delegated: the items are rebuilt on every snapshot. Dropping on the
 * top half of an entry inserts before it; on the bottom half after it
 * (before its next sibling, or the end when none remains). */
function setupDragAndDrop(list: HTMLElement): void {
  list.addEventListener('dragstart', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('.rail-item');
    if (item === null) return;
    const id = item.dataset.id;
    if (id === undefined || id === '') return;
    draggedProfileId = id;
    item.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', id);
      event.dataTransfer.effectAllowed = 'move';
    }
  });
  list.addEventListener('dragover', (event) => {
    if (draggedProfileId === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const item =
      (event.target as HTMLElement).closest<HTMLElement>('.rail-item') ?? nearestItem(list, event.clientY);
    clearDropIndicator(list);
    if (item === null || item.dataset.id === draggedProfileId) return;
    const rect = item.getBoundingClientRect();
    item.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('dragleave', (event) => {
    const related = event.relatedTarget as Node | null;
    if (related === null || !list.contains(related)) clearDropIndicator(list);
  });
  list.addEventListener('drop', (event) => {
    event.preventDefault();
    const id = draggedProfileId;
    clearDropIndicator(list);
    draggedProfileId = null;
    for (const el of list.querySelectorAll<HTMLElement>('.rail-item.dragging')) {
      el.classList.remove('dragging');
    }
    if (id === null) return;
    const item =
      (event.target as HTMLElement).closest<HTMLElement>('.rail-item') ?? nearestItem(list, event.clientY);
    let beforeId: string | null = null;
    if (item !== null) {
      const rect = item.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      const target = before ? item : (item.nextElementSibling as HTMLElement | null);
      beforeId = target?.dataset.id ?? null;
    }
    window.electron.postReorderProfile(id, beforeId);
  });
  list.addEventListener('dragend', () => {
    draggedProfileId = null;
    for (const el of list.querySelectorAll<HTMLElement>('.rail-item.dragging')) {
      el.classList.remove('dragging');
    }
    clearDropIndicator(list);
  });
}

function closeRailMenu(): void {
  railMenuClose?.();
  railMenuClose = null;
  if (railMenu !== null) {
    const active = railMenu.ownerDocument.activeElement;
    if (active !== null && railMenu.contains(active)) (active as HTMLElement).blur();
    railMenu.hidden = true;
  }
  railMenuProfile = null;
}

/** Clamps the open menu's top so it stays fully inside the rail view. */
function positionRailMenu(menu: HTMLElement): void {
  menu.style.top = `${Math.max(4, Math.min(railMenuY, window.innerHeight - menu.offsetHeight - 4))}px`;
}

function showRailMenuActions(menu: HTMLElement): void {
  const profile = railMenuProfile;
  if (profile === null) return;
  menu.textContent = '';
  const reloadServer = document.createElement('button');
  reloadServer.type = 'button';
  reloadServer.textContent = 'Reload server';
  reloadServer.addEventListener('click', () => {
    window.electron.postReloadServer(profile.id);
    closeRailMenu();
  });
  const reloadAll = document.createElement('button');
  reloadAll.type = 'button';
  reloadAll.textContent = 'Reload all servers';
  reloadAll.addEventListener('click', () => {
    window.electron.postReloadAllServers();
    closeRailMenu();
  });
  const sessions = document.createElement('button');
  sessions.type = 'button';
  sessions.textContent = 'Open sessions';
  sessions.addEventListener('click', () => {
    window.electron.postOpenServerSessions(profile.id);
    closeRailMenu();
  });
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.textContent = 'Rename';
  rename.addEventListener('click', () => showRailMenuRename(menu));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => showRailMenuRemoveConfirm(menu));
  menu.append(reloadServer, reloadAll, sessions, rename, remove);
  positionRailMenu(menu);
  rename.focus();
}

function saveRename(input: HTMLInputElement): void {
  const profile = railMenuProfile;
  const name = input.value.trim();
  if (profile !== null && name !== '') window.electron.postRenameProfile(profile.id, name);
  closeRailMenu();
}

function showRailMenuRename(menu: HTMLElement): void {
  const profile = railMenuProfile;
  if (profile === null) return;
  menu.textContent = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = profile.name;
  input.spellcheck = false;
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save';
  save.addEventListener('click', () => saveRename(input));
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeRailMenu);
  menu.append(input, save, cancel);
  positionRailMenu(menu);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveRename(input);
    }
  });
  input.focus();
  input.select();
}

function showRailMenuRemoveConfirm(menu: HTMLElement): void {
  const profile = railMenuProfile;
  if (profile === null) return;
  menu.textContent = '';
  const text = document.createElement('p');
  text.className = 'menu-title';
  const name = document.createElement('strong');
  name.textContent = profile.name;
  text.append('Remove ', name, ` (${profile.origin})?`);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    window.electron.postRemoveProfile(profile.id);
    closeRailMenu();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeRailMenu);
  menu.append(text, remove, cancel);
  positionRailMenu(menu);
  remove.focus();
}

function openRailMenu(profile: RailProfile, y: number): void {
  const menu = railMenu;
  if (menu === null) return;
  closeRailMenu();
  railMenuProfile = profile;
  railMenuY = y;
  menu.hidden = false;
  menu.style.left = '4px';
  showRailMenuActions(menu);
  // The rail gutter is 72px wide, so horizontal placement is fixed.
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeRailMenu();
  };
  const onDocClick = (event: MouseEvent): void => {
    // composedPath is fixed at dispatch time, so a mode switch inside
    // the menu cannot turn its own click into an outside click.
    if (!event.composedPath().includes(menu)) closeRailMenu();
  };
  menu.addEventListener('keydown', onKeydown);
  const menuDoc = menu.ownerDocument;
  menuDoc.addEventListener('click', onDocClick);
  railMenuClose = () => {
    menu.removeEventListener('keydown', onKeydown);
    menuDoc.removeEventListener('click', onDocClick);
  };
}

/** Wires the rail page: the + button opens the add-server picker
 * (window.electron.postOpenPicker); every phi:rail-state snapshot
 * re-renders the list. */
export function boot(): void {
  closeRailMenu();
  railMenu = document.getElementById('rail-menu');
  const list = document.getElementById('rail-list');
  if (list !== null) setupDragAndDrop(list);
  const addButton = document.getElementById('rail-add');
  if (addButton !== null) {
    addButton.addEventListener('click', () => window.electron.postOpenPicker());
  }
  window.electron.onRailState(render);
}

// Auto-boot when loaded as the rail page module — only when the preload
// bridge exists (importing the module under vitest is inert; tests call
// boot() explicitly with a recording-fake bridge).
if (
  typeof window !== 'undefined' &&
  typeof window.electron !== 'undefined' &&
  typeof window.electron.onRailState === 'function'
) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
