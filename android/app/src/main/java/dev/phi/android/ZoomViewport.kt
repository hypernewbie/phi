package dev.phi.android

/**
 * The page-zoom geometry, kept pure so it can be unit tested.
 *
 * Desktop parity (desktop/electron/src/zoom.ts applyContentZoom): zoom is
 * a layout scale factor, never a font-size change. Electron's
 * setZoomFactor(percent / 100) makes the layout viewport
 * `windowCss / zoom` css pixels wide and re-rasterizes the page at that
 * scale. The shell reaches the same result through the page's viewport,
 * so the arithmetic lives here.
 */
object ZoomViewport {
    /**
     * The css-pixel width the page should lay out at for [zoom] percent.
     *
     * @param contentPx the content box width in physical pixels
     * @param density the display density (physical pixels per css pixel)
     * @param zoom the zoom percentage (100 = unscaled)
     * @return the viewport width in css pixels, or 0 for "100% / as served"
     */
    fun widthCss(contentPx: Int, density: Float, zoom: Int): Int {
        if (zoom == 100) return 0
        val baseCss = (contentPx.coerceAtLeast(1) / density)
        return Math.round(baseCss * 100f / zoom).coerceAtLeast(1)
    }
}
