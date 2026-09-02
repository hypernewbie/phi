import type { RailHealth, RailMenuState, RailProfile } from './electron.js';

type MenuMode = 'actions' | 'rename' | 'remove';

function targetProfileId(): string {
  return new URLSearchParams(window.location.search).get('profile') ?? '';
}

function menuRoot(): HTMLElement | null {
  return document.getElementById('rail-menu-root');
}

let selected: RailProfile | null = null;
let health: RailHealth = 'unknown';
let unread = 0;
let mode: MenuMode = 'actions';
let booted = false;

function closeMenu(): void {
  mode = 'actions';
  window.electron.postCloseRailMenu();
}

function displayIdentity(profile: RailProfile): string {
  const hostname = (profile.hostname ?? '').trim().toUpperCase();
  return hostname.replace(/\.LOCAL\.?$/, '') || profile.name;
}

function statusLabel(): string {
  if (health === 'up') return 'Connected';
  if (health === 'down') return 'Offline';
  return 'Checking connection';
}

function makeAction(
  icon: string,
  label: string,
  onClick: () => void,
  className = '',
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `rail-menu-action ${className}`.trim();
  button.setAttribute('role', 'menuitem');
  const glyph = document.createElement('span');
  glyph.className = 'rail-menu-action-icon';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = icon;
  const text = document.createElement('span');
  text.textContent = label;
  button.append(glyph, text);
  button.addEventListener('click', onClick);
  return button;
}

function makeSectionLabel(label: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'rail-menu-section-label';
  element.textContent = label;
  return element;
}

function makeDivider(): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'rail-menu-divider';
  element.setAttribute('role', 'separator');
  return element;
}

function makeHeader(panel: HTMLElement): void {
  if (selected === null) return;
  const header = document.createElement('header');
  header.className = 'rail-menu-header';

  const kicker = document.createElement('div');
  kicker.className = 'rail-menu-kicker';
  kicker.textContent = 'Server';
  const title = document.createElement('div');
  title.className = 'rail-menu-title';
  title.textContent = selected.name || displayIdentity(selected);
  const identity = document.createElement('div');
  identity.className = 'rail-menu-identity';
  identity.textContent = displayIdentity(selected);
  const origin = document.createElement('div');
  origin.className = 'rail-menu-origin';
  origin.textContent = selected.origin;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'rail-menu-close';
  close.setAttribute('aria-label', 'Close server menu');
  close.textContent = '×';
  close.addEventListener('click', closeMenu);

  const status = document.createElement('div');
  status.className = 'rail-menu-status';
  const dot = document.createElement('span');
  dot.className = `rail-menu-status-dot is-${health}`;
  dot.setAttribute('aria-hidden', 'true');
  const statusText = document.createElement('span');
  statusText.textContent = statusLabel();
  status.append(dot, statusText);
  if (unread > 0) {
    const unreadText = document.createElement('span');
    unreadText.className = 'rail-menu-unread';
    unreadText.textContent = `${unread} unread`;
    status.appendChild(unreadText);
  }

  header.append(kicker, title, close, identity, origin, status);
  panel.appendChild(header);
}

function renderActions(panel: HTMLElement): void {
  const profile = selected;
  if (profile === null) return;
  panel.appendChild(makeSectionLabel('Server'));
  panel.append(
    makeAction('▣', 'Open sessions', () => {
      window.electron.postOpenServerSessions(profile.id);
      closeMenu();
    }),
    makeAction('↻', 'Reload server', () => {
      window.electron.postReloadServer(profile.id);
      closeMenu();
    }),
    makeAction('⟳', 'Reload all servers', () => {
      window.electron.postReloadAllServers();
      closeMenu();
    }),
    makeDivider(),
    makeSectionLabel('Profile'),
    makeAction('✎', 'Rename', () => {
      mode = 'rename';
      render();
    }),
    makeAction(
      '×',
      'Remove server',
      () => {
        mode = 'remove';
        render();
      },
      'rail-menu-action-danger',
    ),
  );
}

function renderRename(panel: HTMLElement): void {
  const profile = selected;
  if (profile === null) return;
  panel.appendChild(makeSectionLabel('Rename profile'));
  const form = document.createElement('form');
  form.className = 'rail-menu-form';
  const label = document.createElement('label');
  label.className = 'rail-menu-form-label';
  label.textContent = 'Choose a name for this server';
  const input = document.createElement('input');
  input.className = 'rail-menu-input';
  input.type = 'text';
  input.value = profile.name;
  input.maxLength = 120;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Server name');
  const actions = document.createElement('div');
  actions.className = 'rail-menu-form-actions';
  const cancel = makeAction('←', 'Cancel', () => {
    mode = 'actions';
    render();
  });
  const save = makeAction('✓', 'Save', () => {
    const name = input.value.trim();
    if (name !== '') window.electron.postRenameProfile(profile.id, name);
    closeMenu();
  });
  actions.append(cancel, save);
  form.append(label, input, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save.click();
  });
  panel.appendChild(form);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function renderRemove(panel: HTMLElement): void {
  const profile = selected;
  if (profile === null) return;
  panel.appendChild(makeSectionLabel('Remove profile'));
  const confirm = document.createElement('p');
  confirm.className = 'rail-menu-confirm';
  confirm.append('Remove ', document.createElement('strong'));
  (confirm.firstElementChild as HTMLElement).textContent =
    displayIdentity(profile);
  confirm.append(' from Phi?');
  const actions = document.createElement('div');
  actions.className = 'rail-menu-form-actions';
  actions.append(
    makeAction('←', 'Keep server', () => {
      mode = 'actions';
      render();
    }),
    makeAction(
      '×',
      'Remove server',
      () => {
        window.electron.postRemoveProfile(profile.id);
        closeMenu();
      },
      'rail-menu-action-danger',
    ),
  );
  panel.append(confirm, actions);
}

function render(): void {
  const root = menuRoot();
  if (root === null) return;
  root.replaceChildren();
  if (selected === null) return;
  const panel = document.createElement('section');
  panel.className = 'rail-menu-panel';
  makeHeader(panel);
  if (mode === 'rename') renderRename(panel);
  else if (mode === 'remove') renderRemove(panel);
  else renderActions(panel);
  root.appendChild(panel);
}

export function renderState(state: RailMenuState): void {
  if (state.profile.id !== targetProfileId()) return;
  selected = state.profile;
  health = state.health;
  unread = state.unread;
  render();
}

export function boot(): void {
  if (booted) return;
  booted = true;
  mode = 'actions';
  window.electron.onRailMenuState(renderState);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
}

if (
  typeof window !== 'undefined' &&
  typeof window.electron !== 'undefined' &&
  typeof window.electron.onRailMenuState === 'function'
) {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
