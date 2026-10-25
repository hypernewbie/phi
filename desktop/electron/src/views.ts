/**
 * ProfileViewManager — the retained per-server-profile WebContentsView
 * lifecycle for the phi-desktop rail (migration step 6B).
 *
 * THREADING CONTRACT: every method runs on Electron's main thread
 * (Electron APIs are not thread-safe; there is exactly one main thread in
 * an Electron app). The view's `webContents.on('did-finish-load', ...)`
 * callback also runs on the main thread, so the manager's internal state
 * needs no locking. Tests substitute recording fakes for every Electron
 * surface, so this module is pure TypeScript: the only 'electron' imports
 * are type-only (erased at runtime — dist/views.js has zero Electron
 * imports). Every Electron surface (BrowserWindow, WebContentsView)
 * arrives constructor-injected.
 *
 * Lifecycle contract (the host loop in src/main.ts drives this):
 *   - addProfile(id, origin) only registers the profile; a
 *     WebContentsView is created LAZILY on the FIRST setActive(id).
 *   - setActive(id) hides the previously active view, then creates
 *     (loadURL + show-on-did-finish-load) or re-shows the target view.
 *     A newly created view stays hidden until its first did-finish-load
 *     (prevents a white flash); an already-created view is just re-shown
 *     with fresh bounds.
 *   - Views are RETAINED: switching back reuses the same WebContentsView
 *     (all using the shared persistent Electron session).
 *   - removeProfile(id) destroys the retained view; destroyAll() tears
 *     every view down on before-quit.
 *   - Only the active view's bounds change on onWindowResize(); hidden
 *     views keep their last bounds and are re-bounded on next activation
 *     (defaultBounds() is re-read on every setActive / onWindowResize —
 *     the window bounds change during use).
 *
 * Same-host note: same-host different-port profiles are NOT blocked at
 * this layer — standard browser origin rules isolate different server
 * origins within the shared session. The controller permits distinct
 * origins, and the view manager registers and retains every saved server
 * it is handed.
 *
 * The manager does NOT touch controller events directly (the host loop in
 * main.ts calls setActive from the controller's active-changed
 * subscription) and does NOT post `phi:rail-state` (that is main.ts's
 * job). The manager only owns the view lifecycle.
 */
import type { BrowserWindow, WebContentsView } from 'electron';
import { installFullscreenToggle } from './fullscreen.js';
import { installReloadShortcut } from './reload.js';
import {
  applyContentZoom,
  installZoomShortcuts,
  type ZoomAction,
} from './zoom.js';
import {
  WAKE_PAGE_SCRIPT,
  lowPowerApplyScript,
  switchToScript,
  forgetScript,
} from './injected.js';

/** Electron Rectangle (bounds). */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Constructor options — every Electron surface is injected. */
export interface ProfileViewManagerOptions {
  /** The host BrowserWindow whose contentView receives the profile views. */
  win: BrowserWindow;
  /** Builds a WebContentsView for a profile origin using the shared persistent session. */
  makeView: (origin: string) => WebContentsView;
  /** The active view's bounds — re-read on every setActive/onWindowResize. */
  defaultBounds: () => ViewBounds;
  /** The rail gutter width (the active view's x offset). */
  railWidth: number;
  /** Reads the persisted global content-zoom percentage. */
  getContentZoomPercent: () => number;
  /** Reads the persisted global low-power mode. Optional (defaults to
   *  false) so older hosts keep compiling; the host loop supplies the
   *  controller-owned global, applied to every view on load (global
   *  wins, content-zoom parity). */
  getLowPowerMode?: () => boolean;
  /** Routes a body-view zoom chord to the controller-owned global action. */
  onZoomAction: (action: ZoomAction) => void;
  /** Optional callback fired when plain F11 toggles fullscreen on any body view. */
  onFullscreenToggle?: (nextFullscreen: boolean) => void;
  /** Diagnostics logger (defaults to a no-op). */
  log?: (s: string) => void;
  /** Enables single-tab embedded mode (one reusable WebContentsView). */
  singleTab?: boolean;
  /** The embedded origin prefix. Defaults to 'phi-app://app'. */
  embeddedOrigin?: string;
  /** Hook fired when switching profiles in single-tab mode. Return false (or Promise<false>) if incompatible. */
  onSingleTabSwitch?: (
    id: string,
    origin: string,
  ) => void | boolean | Promise<boolean>;
}

/** One registered (not yet necessarily materialized) profile. */
interface RegisteredProfile {
  id: string;
  origin: string;
}

/** One retained per-profile view record. */
interface ViewEntry {
  view: WebContentsView;
  /** True after the view's first did-finish-load. */
  loaded: boolean;
  /** True while the access-auth modal is open (modal lives in the main
   *  view's parent webContents; it can't paint over the child, so the
   *  child stays hidden while the modal owns the surface). */
  obscured: boolean;
  /** The last bounds applied to the view (hidden views keep theirs). */
  lastBounds?: ViewBounds;
}

/**
 * The retained per-profile WebContentsView lifecycle (see the file-header
 * contract). The manager only owns the view lifecycle: the host loop in
 * main.ts drives setActive from the controller's active-changed events
 * and posts phi:rail-state itself.
 */
export class ProfileViewManager {
  private readonly win: BrowserWindow;
  private readonly makeView: (origin: string) => WebContentsView;
  private readonly defaultBounds: () => ViewBounds;
  private readonly railWidth: number;
  private readonly getContentZoomPercent: () => number;
  private readonly getLowPowerMode: () => boolean;
  private readonly onZoomAction: (action: ZoomAction) => void;
  private readonly onFullscreenToggle?: (nextFullscreen: boolean) => void;
  private readonly log: (s: string) => void;
  private readonly profiles = new Map<string, RegisteredProfile>();
  private readonly views = new Map<string, ViewEntry>();
  private activeId: string | null = null;
  private singleTab: boolean;
  private readonly embeddedOrigin: string;
  private readonly onSingleTabSwitch?: (
    id: string,
    origin: string,
  ) => void | boolean | Promise<boolean>;
  private singleEntry: ViewEntry | null = null;
  private singleEntryMode: 'embedded' | 'legacy' | null = null;

  constructor(opts: ProfileViewManagerOptions) {
    this.win = opts.win;
    this.makeView = opts.makeView;
    this.defaultBounds = opts.defaultBounds;
    this.railWidth = opts.railWidth;
    this.getContentZoomPercent = opts.getContentZoomPercent;
    this.getLowPowerMode = opts.getLowPowerMode ?? (() => false);
    this.onZoomAction = opts.onZoomAction;
    this.onFullscreenToggle = opts.onFullscreenToggle;
    this.log = opts.log ?? (() => {});
    this.singleTab = opts.singleTab ?? false;
    this.embeddedOrigin = opts.embeddedOrigin ?? 'phi-app://app';
    this.onSingleTabSwitch = opts.onSingleTabSwitch;
  }

  isSingleTab(): boolean {
    return this.singleTab;
  }

  setSingleTab(enabled: boolean): void {
    if (this.singleTab === enabled) return;
    this.singleTab = enabled;
    if (enabled) {
      for (const entry of this.views.values()) {
        try {
          this.teardownView(entry);
        } catch (err) {
          this.log(`views: setSingleTab teardown: ${String(err)}`);
        }
      }
      this.views.clear();
      if (this.activeId !== null) {
        const prev = this.activeId;
        this.activeId = null;
        this.setActive(prev);
      }
    } else {
      if (this.singleEntry) {
        try {
          this.teardownView(this.singleEntry);
        } catch (err) {
          this.log(`views: setSingleTab teardown single: ${String(err)}`);
        }
        this.singleEntry = null;
        this.singleEntryMode = null;
      }
      if (this.activeId !== null) {
        const prev = this.activeId;
        this.activeId = null;
        this.setActive(prev);
      }
    }
  }

  private buildEmbeddedUrl(id: string, origin: string): string {
    return `${this.embeddedOrigin}/index.html?desktop=1&embedded=1&profile=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin)}`;
  }

  private buildLegacyUrl(origin: string): string {
    const rootUrl = new URL(origin);
    rootUrl.searchParams.set('desktop', '1');
    return rootUrl.toString();
  }

  /**
   * Registers a profile. Does NOT create a WebContentsView — that happens
   * lazily on the first setActive(id). A duplicate id is a no-op (the
   * first origin wins).
   */
  addProfile(id: string, origin: string): void {
    if (this.profiles.has(id)) {
      this.log(`views: addProfile(${id}) — already registered, no-op`);
      return;
    }
    this.profiles.set(id, { id, origin });
    this.log(
      `views: registered profile ${id} (${origin}) — view created on first activation`,
    );
  }

  /**
   * Removes a profile: destroys its retained view (if any). The active id
   * is cleared when the removed profile was active.
   */
  removeProfile(id: string): void {
    if (this.singleTab) {
      if (
        this.singleEntry?.view.webContents &&
        typeof this.singleEntry.view.webContents.executeJavaScript === 'function'
      ) {
        void this.singleEntry.view.webContents
          .executeJavaScript(forgetScript(id))
          .catch(() => {});
      }
      this.profiles.delete(id);
      if (this.activeId === id) {
        this.singleEntry?.view.setVisible(false);
        this.activeId = null;
      }
      if (this.profiles.size === 0 && this.singleEntry) {
        this.teardownView(this.singleEntry);
        this.singleEntry = null;
        this.singleEntryMode = null;
      }
      this.log(`views: removed profile ${id} (single-tab mode)`);
      return;
    }
    const entry = this.views.get(id);
    if (entry) {
      this.teardownView(entry);
      this.views.delete(id);
      if (this.activeId === id) this.activeId = null;
      this.log(`views: removed profile ${id} — retained view destroyed`);
    }
    this.profiles.delete(id);
  }

  /**
   * Switches the active view. A null/empty id hides the current view and
   * clears the active id. A newly created view is hidden until its first
   * did-finish-load (no white flash); an already-created (retained) view
   * is re-shown immediately with fresh bounds. Unknown ids are a no-op.
   */
  setActive(id: string | null): void {
    const target = id ?? '';
    if (this.singleTab) {
      if (target === '') {
        if (this.singleEntry) this.singleEntry.view.setVisible(false);
        this.activeId = null;
        this.log('views: setActive(null) — active view hidden');
        return;
      }
      if (target === this.activeId) return; // already active
      const profile = this.profiles.get(target);
      if (!profile) {
        this.log(`views: setActive(${target}) — unknown profile, no-op`);
        return;
      }
      this.activeId = target;
      if (!this.singleEntry) {
        this.ensureSingleView(target, profile.origin);
      } else {
        const bounds = this.defaultBounds();
        this.singleEntry.view.setBounds(bounds);
        this.singleEntry.lastBounds = bounds;
        applyContentZoom(
          this.singleEntry.view.webContents,
          this.getContentZoomPercent(),
        );
        if (this.singleEntry.loaded && !this.singleEntry.obscured) {
          this.singleEntry.view.setVisible(true);
        }
        if (
          this.singleEntry.view.webContents &&
          !this.singleEntry.view.webContents.isDestroyed()
        ) {
          this.singleEntry.view.webContents.focus();
          if (
            typeof this.singleEntry.view.webContents.executeJavaScript ===
            'function'
          ) {
            void this.singleEntry.view.webContents
              .executeJavaScript(WAKE_PAGE_SCRIPT)
              .catch(() => {});
          }
        }
        this.activateInSingleView(target, profile.origin, false);
      }
      return;
    }

    if (target === '') {
      this.hideActiveView();
      this.activeId = null;
      this.log('views: setActive(null) — active view hidden');
      return;
    }
    if (target === this.activeId) return; // already active (idempotent)
    const profile = this.profiles.get(target);
    if (!profile) {
      this.log(`views: setActive(${target}) — unknown profile, no-op`);
      return;
    }
    this.hideActiveView();
    const existing = this.views.get(target);
    if (existing) {
      // Retained view: re-show with fresh bounds (the window may have
      // been resized while this profile was inactive; hidden views kept
      // their last bounds until now).
      const bounds = this.defaultBounds();
      existing.view.setBounds(bounds);
      existing.lastBounds = bounds;
      applyContentZoom(existing.view.webContents, this.getContentZoomPercent());
      existing.view.setVisible(true);
      // Keyboard/shortcuts route to the newly shown view (the outgoing
      if (
        existing.view.webContents &&
        !existing.view.webContents.isDestroyed()
      ) {
        existing.view.webContents.focus();
        if (typeof existing.view.webContents.executeJavaScript === 'function') {
          void existing.view.webContents
            .executeJavaScript(WAKE_PAGE_SCRIPT)
            .catch(() => {});
        }
      }
    } else {
      // First activation: created hidden; shown after did-finish-load.
      this.ensureView(target, profile.origin);
    }
    this.activeId = target;
  }

  /** Re-bounds ONLY the active view (hidden views keep their last bounds;
   * they are re-bounded on next activation). */
  onWindowResize(): void {
    if (this.activeId === null) return;
    if (this.singleTab) {
      if (!this.singleEntry) return;
      const bounds = this.defaultBounds();
      this.singleEntry.view.setBounds(bounds);
      this.singleEntry.lastBounds = bounds;
      return;
    }
    const entry = this.views.get(this.activeId);
    if (!entry) return;
    const bounds = this.defaultBounds();
    entry.view.setBounds(bounds);
    entry.lastBounds = bounds;
  }

  /** The current active profile id, or null when none. */
  getActive(): string | null {
    return this.activeId;
  }

  /** The retained view for a profile id, or null when none exists yet. */
  getView(id: string): WebContentsView | null {
    if (this.singleTab) {
      return this.singleEntry && this.profiles.has(id)
        ? this.singleEntry.view
        : null;
    }
    return this.views.get(id)?.view ?? null;
  }

  /**
   * Fans a persisted global content-zoom percentage out to every live
   * retained view, including hidden views (so a low-memory recreation or
   * re-activation never shows an unzoomed frame first).
   */
  setContentZoomPercent(percent: number): void {
    if (this.singleTab) {
      if (this.singleEntry) {
        applyContentZoom(this.singleEntry.view.webContents, percent);
      }
      return;
    }
    for (const entry of this.views.values()) {
      applyContentZoom(entry.view.webContents, percent);
    }
  }

  /** The count of retained (created) views — the smoke-payload surface. */
  viewsCreated(): number {
    return this.singleTab ? (this.singleEntry ? 1 : 0) : this.views.size;
  }

  /**
   * Obscures the active body view (if any) without dropping it: hidden
   * so it does not capture input; not removed from the layout; can be
   * re-shown with `setObscured(false)` while keeping the same `setActive`
   * selection. Used while an in-flow access-auth modal is open — the
   * modal lives in the main view's parent webContents and CANNOT paint
   * above a child WebContentsView, so we hide the child explicitly.
   * Rail is unaffected. Late `did-finish-load` on a hidden view that
   * becomes the active view stays hidden until `setObscured(false)`.
   */
  setObscured(obscured: boolean): void {
    if (this.activeId === null) return;
    if (this.singleTab) {
      if (!this.singleEntry) return;
      this.singleEntry.obscured = obscured;
      if (obscured && this.singleEntry.loaded) {
        this.singleEntry.view.setVisible(false);
      }
      if (!obscured && this.singleEntry.loaded) {
        this.singleEntry.view.setVisible(true);
        applyContentZoom(
          this.singleEntry.view.webContents,
          this.getContentZoomPercent(),
        );
      }
      return;
    }
    const entry = this.views.get(this.activeId);
    if (!entry) return;
    entry.obscured = obscured;
    if (obscured && entry.loaded) entry.view.setVisible(false);
    if (!obscured && entry.loaded) {
      entry.view.setVisible(true);
      applyContentZoom(entry.view.webContents, this.getContentZoomPercent());
    }
  }

  /**
   * Reloads all retained profile views (Idea E).
   * Used on Alt+F5 / Cmd+Alt+R or rail "Reload all servers".
   */
  reloadAll(ignoringCache = false): void {
    if (this.singleTab) {
      if (
        this.singleEntry?.view.webContents &&
        !this.singleEntry.view.webContents.isDestroyed()
      ) {
        if (ignoringCache) {
          this.singleEntry.view.webContents.reloadIgnoringCache();
        } else {
          this.singleEntry.view.webContents.reload();
        }
        this.log(
          `views: reloadAll (single-tab) — reloaded view (ignoringCache=${ignoringCache})`,
        );
      }
      return;
    }
    for (const [id, entry] of this.views.entries()) {
      if (entry.view.webContents && !entry.view.webContents.isDestroyed()) {
        if (ignoringCache) {
          entry.view.webContents.reloadIgnoringCache();
        } else {
          entry.view.webContents.reload();
        }
        this.log(
          `views: reloadAll — reloaded profile ${id} (ignoringCache=${ignoringCache})`,
        );
      }
    }
  }

  /**
   * Reloads the active profile view, or a specific profile view by id.
   */
  reloadActive(targetId?: string, ignoringCache = false): void {
    if (this.singleTab) {
      if (
        this.singleEntry?.view.webContents &&
        !this.singleEntry.view.webContents.isDestroyed()
      ) {
        if (ignoringCache) {
          this.singleEntry.view.webContents.reloadIgnoringCache();
        } else {
          this.singleEntry.view.webContents.reload();
        }
        this.log(
          `views: reloadActive (single-tab) — reloaded view (ignoringCache=${ignoringCache})`,
        );
      }
      return;
    }
    const id = targetId ?? this.activeId;
    if (!id) return;
    const entry = this.views.get(id);
    if (entry?.view.webContents && !entry.view.webContents.isDestroyed()) {
      if (ignoringCache) {
        entry.view.webContents.reloadIgnoringCache();
      } else {
        entry.view.webContents.reload();
      }
      this.log(
        `views: reloaded profile ${id} (ignoringCache=${ignoringCache})`,
      );
    }
  }

  /** The active retained view's webContents, or null when none. */
  getActiveView(): WebContentsView | null {
    if (this.singleTab) {
      return this.singleEntry && this.activeId ? this.singleEntry.view : null;
    }
    if (!this.activeId) return null;
    return this.views.get(this.activeId)?.view ?? null;
  }

  /**
   * Closes + destroys every retained view and clears the manager
   * (before-quit teardown). Never throws: per-view failures are logged
   * and the teardown continues.
   */
  async destroyAll(): Promise<void> {
    if (this.singleTab && this.singleEntry) {
      try {
        this.teardownView(this.singleEntry);
      } catch (err) {
        this.log(`views: destroyAll single: ${String(err)}`);
      }
      this.singleEntry = null;
      this.singleEntryMode = null;
    }
    for (const entry of [...this.views.values()]) {
      try {
        this.teardownView(entry);
      } catch (err) {
        this.log(`views: destroyAll: ${String(err)}`);
      }
    }
    this.views.clear();
    this.profiles.clear();
    this.activeId = null;
    this.log('views: destroyAll — all retained views closed and destroyed');
  }

  /** Closes the view's webContents and removes the view from the window.
   *  (WebContentsView does not expose `.destroy()`; the documented
   *  teardown is webContents.close() + window.contentView.removeChildView.) */
  private teardownView(entry: ViewEntry): void {
    if (entry.view.webContents && !entry.view.webContents.isDestroyed())
      entry.view.webContents.close();
    this.win.contentView.removeChildView(entry.view);
  }

  /** Low memory mode: destroy every inactive retained view, keep only keepId (massively aggro, 1 tab). */
  hibernateInactive(keepId: string): void {
    if (this.singleTab) {
      this.log('views: hibernateInactive (single-tab) — no-op');
      return;
    }
    for (const [id, entry] of [...this.views.entries()]) {
      if (id === keepId) continue;
      try {
        this.teardownView(entry);
      } catch (err) {
        this.log(`views: hibernateInactive ${id}: ${String(err)}`);
      }
      this.views.delete(id);
      this.log(
        `views: hibernateInactive — destroyed ${id}, kept ${keepId || '(none)'}`,
      );
    }
  }

  /** Restore point for low-memory off: next setActive will lazily recreate. No-op besides log. */
  restoreAll(): void {
    this.log(
      `views: restoreAll — low memory off, ${this.views.size} views retained, rest will lazy-create`,
    );
  }

  /**
   * Immediate low-power fan-out: applies `enabled` to every LOADED
   * retained view right now (the tray toggle path). Views still loading
   * are skipped — their pending did-finish-load reads the same global
   * and converges there. Never throws; per-view failures are logged.
   */
  applyLowPowerToViews(enabled: boolean): void {
    const script = lowPowerApplyScript(enabled);
    if (this.singleTab) {
      if (
        this.singleEntry?.loaded &&
        typeof this.singleEntry.view.webContents.executeJavaScript ===
          'function'
      ) {
        void this.singleEntry.view.webContents
          .executeJavaScript(script)
          .catch(() => {});
      }
      this.log(
        `views: applyLowPowerToViews(${enabled}) (single-tab) — applied to single view`,
      );
      return;
    }
    for (const [id, entry] of [...this.views.entries()]) {
      if (!entry.loaded) continue;
      try {
        if (typeof entry.view.webContents.executeJavaScript !== 'function')
          continue;
        void entry.view.webContents.executeJavaScript(script).catch(() => {});
      } catch (err) {
        this.log(`views: applyLowPowerToViews ${id}: ${String(err)}`);
      }
    }
    this.log(
      `views: applyLowPowerToViews(${enabled}) — fanned out to loaded views`,
    );
  }

  private hideActiveView(): void {
    if (this.activeId === null) return;
    const prev = this.views.get(this.activeId);
    if (prev) prev.view.setVisible(false);
  }

  private ensureSingleView(id: string, origin: string): ViewEntry {
    const view = this.makeView(this.embeddedOrigin);
    const entry: ViewEntry = { view, loaded: false, obscured: false };
    this.singleEntry = entry;
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    const bounds = this.defaultBounds();
    view.setBounds(bounds);
    entry.lastBounds = bounds;
    applyContentZoom(view.webContents, this.getContentZoomPercent());

    view.webContents.on('did-finish-load', () => {
      if (this.singleEntry?.view !== view) return;
      const fresh = this.defaultBounds();
      view.setBounds(fresh);
      entry.lastBounds = fresh;
      applyContentZoom(view.webContents, this.getContentZoomPercent());
      if (typeof view.webContents.executeJavaScript === 'function') {
        void view.webContents
          .executeJavaScript(lowPowerApplyScript(this.getLowPowerMode()))
          .catch(() => {});
      }
      entry.loaded = true;
      if (this.activeId !== null && !entry.obscured) {
        view.setVisible(true);
        applyContentZoom(view.webContents, this.getContentZoomPercent());
        if (!view.webContents.isDestroyed()) {
          view.webContents.focus();
          if (typeof view.webContents.executeJavaScript === 'function') {
            void view.webContents
              .executeJavaScript(WAKE_PAGE_SCRIPT)
              .catch(() => {});
          }
        }
      }
    });

    installFullscreenToggle(
      view.webContents,
      this.win,
      this.onFullscreenToggle,
    );
    if (this.onFullscreenToggle) {
      const onToggle = this.onFullscreenToggle;
      view.webContents.on('enter-html-full-screen', () => onToggle(true));
      view.webContents.on('leave-html-full-screen', () => onToggle(false));
    }
    installReloadShortcut(view.webContents, undefined, (ignoringCache) =>
      this.reloadAll(ignoringCache),
    );
    installZoomShortcuts(view.webContents, (action) =>
      this.onZoomAction(action),
    );

    this.activateInSingleView(id, origin, true);
    return entry;
  }

  private activateInSingleView(
    id: string,
    origin: string,
    isInitialCreate: boolean,
  ): void {
    if (!this.singleEntry) return;
    const view = this.singleEntry.view;
    const switchResult = this.onSingleTabSwitch?.(id, origin);

    if (switchResult === false) {
      this.singleEntryMode = 'legacy';
      view.webContents.loadURL(this.buildLegacyUrl(origin));
      return;
    }

    if (switchResult instanceof Promise) {
      if (isInitialCreate) {
        this.singleEntryMode = 'embedded';
        view.webContents.loadURL(this.buildEmbeddedUrl(id, origin));
        void switchResult.then((compat) => {
          if (!compat && this.activeId === id) {
            this.singleEntryMode = 'legacy';
            view.webContents.loadURL(this.buildLegacyUrl(origin));
          }
        });
      } else {
        void switchResult.then(async (compat) => {
          if (this.activeId !== id) return;
          if (!compat) {
            this.singleEntryMode = 'legacy';
            view.webContents.loadURL(this.buildLegacyUrl(origin));
          } else if (this.singleEntryMode === 'legacy') {
            this.singleEntryMode = 'embedded';
            view.webContents.loadURL(this.buildEmbeddedUrl(id, origin));
          } else {
            let switched = false;
            if (typeof view.webContents.executeJavaScript === 'function') {
              try {
                switched = Boolean(
                  await view.webContents.executeJavaScript(
                    switchToScript(id, origin),
                  ),
                );
              } catch {
                switched = false;
              }
            }
            if (!switched) {
              this.singleEntryMode = 'embedded';
              view.webContents.loadURL(this.buildEmbeddedUrl(id, origin));
            }
          }
        });
      }
      return;
    }

    // Synchronous true or undefined
    if (isInitialCreate || this.singleEntryMode === 'legacy') {
      this.singleEntryMode = 'embedded';
      view.webContents.loadURL(this.buildEmbeddedUrl(id, origin));
    } else {
      let switched = false;
      if (typeof view.webContents.executeJavaScript === 'function') {
        try {
          const res = view.webContents.executeJavaScript(
            switchToScript(id, origin),
          );
          if (res instanceof Promise) {
            void res
              .then((handled) => {
                if (!handled) {
                  this.singleEntryMode = 'embedded';
                  view.webContents.loadURL(this.buildEmbeddedUrl(id, origin));
                }
              })
              .catch(() => {
                this.singleEntryMode = 'embedded';
                view.webContents.loadURL(this.buildEmbeddedUrl(id, origin));
              });
            return;
          }
          switched = Boolean(res);
        } catch {
          switched = false;
        }
      }
      if (!switched) {
        this.singleEntryMode = 'embedded';
        view.webContents.loadURL(this.buildEmbeddedUrl(id, origin));
      }
    }
  }

  /**
   * Creates (once) the retained view for a profile: adds it to the
   * window's contentView, hides it, subscribes to did-finish-load BEFORE
   * the load starts (so the view only becomes visible after its initial
   * load — no white flash) and loadURLs the profile's origin.
   */
  private ensureView(id: string, origin: string): ViewEntry {
    const existing = this.views.get(id);
    if (existing) return existing;
    const view = this.makeView(origin);
    const entry: ViewEntry = { view, loaded: false, obscured: false };
    this.views.set(id, entry);
    this.win.contentView.addChildView(view);
    // Hidden until the first did-finish-load; the callback runs on the
    // main thread (file-header threading contract). It only shows the
    // view when this profile is still the active one (a view switched
    // away mid-load stays hidden until re-activated).
    view.setVisible(false);
    const bounds = this.defaultBounds();
    view.setBounds(bounds);
    entry.lastBounds = bounds;
    applyContentZoom(view.webContents, this.getContentZoomPercent());
    view.webContents.on('did-finish-load', () => {
      const current = this.views.get(id);
      if (!current || current.view !== view) return; // removed meanwhile
      const fresh = this.defaultBounds();
      view.setBounds(fresh);
      current.lastBounds = fresh;
      applyContentZoom(view.webContents, this.getContentZoomPercent());
      // Desktop-global low power mode wins on every load (content-zoom
      // parity): the tray checkbox is the one durable switch, so a view
      // that missed the fan-out (created later, reloaded, navigated)
      // converges here. The installed controller also guards against
      // legacy UIs overwriting the class after asynchronous config loads.
      if (typeof view.webContents.executeJavaScript === 'function') {
        void view.webContents
          .executeJavaScript(lowPowerApplyScript(this.getLowPowerMode()))
          .catch(() => {});
      }
      current.loaded = true;
      // If an access-auth modal is currently open (or the active id
      // switched away), leave the view hidden. ProfileViewManager
      // re-shows it once `setObscured(false)` fires.
      if (this.activeId === id && !current.obscured) {
        view.setVisible(true);
        applyContentZoom(view.webContents, this.getContentZoomPercent());
        // Keyboard/shortcuts route to the newly shown view.
        if (!view.webContents.isDestroyed()) {
          view.webContents.focus();
          if (typeof view.webContents.executeJavaScript === 'function') {
            void view.webContents
              .executeJavaScript(WAKE_PAGE_SCRIPT)
              .catch(() => {});
          }
        }
      }
    });
    // Plain F11 toggles fullscreen on the BrowserWindow from any retained
    // body view (the main-view listener in desktop.ts does not catch keys
    // that fire while a body view has focus). Modified F11 chords stay
    // untouched; xterm.js leaves plain F11 unbound.
    installFullscreenToggle(
      view.webContents,
      this.win,
      this.onFullscreenToggle,
    );
    if (this.onFullscreenToggle) {
      const onToggle = this.onFullscreenToggle;
      view.webContents.on('enter-html-full-screen', () => onToggle(true));
      view.webContents.on('leave-html-full-screen', () => onToggle(false));
    }
    installReloadShortcut(view.webContents, undefined, (ignoringCache) =>
      this.reloadAll(ignoringCache),
    );
    installZoomShortcuts(view.webContents, (action) =>
      this.onZoomAction(action),
    );
    const rootUrl = new URL(origin);
    rootUrl.searchParams.set('desktop', '1');
    view.webContents.loadURL(rootUrl.toString());
    this.log(
      `views: created view for ${id} (${origin}), rail gutter ${this.railWidth}px; shown after did-finish-load`,
    );
    return entry;
  }
}
