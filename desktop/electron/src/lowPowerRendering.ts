/**
 * Self-contained page controller, serialized by lowPowerApplyScript. No imports
 * or module-scope references: the same code runs in old remote UIs and local
 * desktop chrome without requiring a server upgrade.
 */
export function installLowPowerRendering(enabled: boolean): void {
  const page = window as Window & {
    __phiDesktopPower?: {
      setEnabled(value: boolean): void;
      dispose(): void;
    };
  };
  if (page.__phiDesktopPower) {
    page.__phiDesktopPower.setEnabled(enabled);
    return;
  }

  let preference = enabled;
  let effective = false;
  const originalRequest = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  // Opaque negative IDs keep queued callbacks distinct from native requests
  // made before installation (which must still be cancellable).
  let nextId = -1;
  let timer: number | undefined;
  let frame: number | undefined;
  let lastFrame = -Infinity;
  const hasFrames = typeof originalRequest === 'function';

  const clearScheduled = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    if (frame !== undefined) originalCancel.call(window, frame);
    timer = undefined;
    frame = undefined;
  };
  const interval = (): number => {
    if (!effective) return 0;
    // Active typing/scrolling remains interactive. An unfocused or hidden
    // Phi must not compete with a foreground game merely to animate a TUI.
    return document.visibilityState === 'visible' && document.hasFocus()
      ? 100
      : 1000;
  };
  const dispatch = (timestamp: number): void => {
    frame = undefined;
    lastFrame = timestamp;
    // Snapshot IDs, not callbacks: an earlier callback may cancel a later one.
    const ids = [...callbacks.keys()];
    for (const id of ids) {
      const callback = callbacks.get(id);
      if (!callback) continue;
      callbacks.delete(id);
      try {
        callback(timestamp);
      } catch (error) {
        // Like native rAF, one failing callback must not drop the others.
        window.setTimeout(() => {
          throw error;
        }, 0);
      }
    }
    schedule();
  };
  const requestNative = (): void => {
    timer = undefined;
    frame = originalRequest.call(window, dispatch);
  };
  const schedule = (): void => {
    if (
      !hasFrames ||
      timer !== undefined ||
      frame !== undefined ||
      !callbacks.size
    )
      return;
    const delay = interval() - (performance.now() - lastFrame);
    if (delay > 0) timer = window.setTimeout(requestNative, delay);
    else requestNative();
  };
  const reschedule = (): void => {
    clearScheduled();
    schedule();
  };

  const style = document.createElement('style');
  style.id = 'phi-desktop-low-power-style';
  style.textContent = `
    html[data-phi-desktop-low-power="true"] *,
    html[data-phi-desktop-low-power="true"] *::before,
    html[data-phi-desktop-low-power="true"] *::after {
      animation: none !important;
      transition: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      will-change: auto !important;
    }
  `;
  document.head.appendChild(style);
  // A narrow desktop rail is not a phone. Only remote body UIs inherit
  // the browser's mobile/compact forced-on policy.
  const remote = /^https?:$/.test(location.protocol);
  const compact =
    remote && typeof window.matchMedia === 'function'
      ? window.matchMedia(
          '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
        )
      : null;
  const syncClass = (): void => {
    const mobile =
      (
        navigator as Navigator & {
          userAgentData?: { mobile?: boolean };
        }
      ).userAgentData?.mobile === true;
    const next = preference || (remote && (!!compact?.matches || mobile));
    const changed = next !== effective;
    effective = next;
    document.body.classList.toggle('fast-mode', effective);
    document.documentElement.setAttribute(
      'data-phi-desktop-low-power',
      String(effective),
    );
    if (changed) reschedule();
  };
  // Old server UIs ignore phi_low_power and reapply config.fast_mode after
  // asynchronous config loads/refreshes. Observe ONLY the body class, not
  // the terminal subtree: enforce the desktop preference without polling.
  const observer = new MutationObserver(() => {
    if (document.body.classList.contains('fast-mode') !== effective)
      syncClass();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  compact?.addEventListener('change', syncClass);
  window.addEventListener('focus', reschedule);
  window.addEventListener('blur', reschedule);
  document.addEventListener('visibilitychange', reschedule);

  if (hasFrames) {
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      const id = nextId--;
      callbacks.set(id, callback);
      schedule();
      return id;
    };
    window.cancelAnimationFrame = (id: number): void => {
      if (id >= 0) originalCancel.call(window, id);
      else callbacks.delete(id);
      if (!callbacks.size) clearScheduled();
    };
  }
  page.__phiDesktopPower = {
    setEnabled(value): void {
      preference = value;
      syncClass();
    },
    dispose(): void {
      observer.disconnect();
      compact?.removeEventListener('change', syncClass);
      window.removeEventListener('focus', reschedule);
      window.removeEventListener('blur', reschedule);
      document.removeEventListener('visibilitychange', reschedule);
      clearScheduled();
      // Transfer still-pending work back to the browser on teardown.
      for (const callback of callbacks.values())
        originalRequest.call(window, callback);
      callbacks.clear();
      if (hasFrames) {
        window.requestAnimationFrame = originalRequest;
        window.cancelAnimationFrame = originalCancel;
      }
      style.remove();
      document.documentElement.removeAttribute('data-phi-desktop-low-power');
      delete page.__phiDesktopPower;
    },
  };
  syncClass();
}
