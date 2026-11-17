/*
 * Phi Android - page zoom through the page viewport.
 *
 * The shell has no embedder-level zoom factor (Android WebView exposes
 * page scale, not Electron's setZoomFactor), so the zoom is applied the
 * way a browser applies it on mobile: the layout viewport is narrowed to
 * the css-pixel width the browser would show at that zoom, and Chromium
 * re-rasterizes at the resulting page scale before fitting it to the
 * screen. `width = baseCss / zoom` is exactly what Electron's
 * setZoomFactor(zoom) does to the layout viewport.
 *
 * This file is the single source of truth for the viewport side of that
 * behaviour and is unit tested (test-js/androidZoomViewport.test.js).
 * The shell injects it into any page it shows and calls
 * __phiZoomViewport(widthCss); width <= 0 means "100%".
 */
(function () {
  var ORIG = 'data-phi-orig';
  var CREATED = 'data-phi-created';

  function findMeta() {
    return document.querySelector('meta[name=viewport]');
  }

  function remember(meta) {
    if (!meta.getAttribute(ORIG)) {
      meta.setAttribute(ORIG, meta.getAttribute('content') || '');
    }
    return meta;
  }

  window.__phiZoomViewport = function (widthCss) {
    try {
      var meta = findMeta();
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.setAttribute(CREATED, '1');
        document.head.appendChild(meta);
      } else {
        remember(meta);
      }
      if (widthCss <= 0) {
        // 100%: restore the page exactly as it was served. A viewport we
        // injected is removed again so a server that never had one keeps
        // its desktop layout.
        if (meta.getAttribute(CREATED)) {
          var parent = meta.parentNode;
          if (parent) parent.removeChild(meta);
        } else {
          meta.setAttribute('content', meta.getAttribute(ORIG) || 'width=device-width');
        }
        return;
      }
      meta.setAttribute('content', 'width=' + widthCss);
    } catch (e) {
      /* a page that refuses the viewport simply stays as it is */
    }
  };
})();
