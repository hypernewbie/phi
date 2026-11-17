package dev.phi.android

import org.junit.Assert.assertEquals
import org.junit.Test

/** The page-zoom geometry must match Electron's setZoomFactor. */
class ZoomViewportTest {
    @Test
    fun `100 percent keeps the page as served`() {
        assertEquals(0, ZoomViewport.widthCss(2560, 2f, 100))
    }

    @Test
    fun `the layout viewport is the window width divided by the zoom`() {
        // A 1280 css px window at 125% lays out at 1024 css px, exactly
        // what Electron's setZoomFactor(1.25) does to the layout viewport.
        assertEquals(1024, ZoomViewport.widthCss(2560, 2f, 125))
        assertEquals(640, ZoomViewport.widthCss(2560, 2f, 200))
        assertEquals(853, ZoomViewport.widthCss(2560, 2f, 150))
    }

    @Test
    fun `zooming out widens the layout viewport`() {
        assertEquals(2560, ZoomViewport.widthCss(2560, 2f, 50))
    }

    @Test
    fun `the tablet density is honoured`() {
        // 1920 physical px at density 1.33125 -> 1442 css px base.
        assertEquals(1154, ZoomViewport.widthCss(1920, 1.33125f, 125))
    }

    @Test
    fun `an unmeasured content box never yields a zero width`() {
        assertEquals(1, ZoomViewport.widthCss(0, 2f, 200))
    }
}
