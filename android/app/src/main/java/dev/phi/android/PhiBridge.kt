package dev.phi.android

import android.webkit.JavascriptInterface

/**
 * `window.__phiDesktop` — the shell's contract with the web client.
 * Every method is a guarded no-op everywhere else (theme.ts calls it
 * behind `?.`). The bridge never touches the DOM: it only reports facts
 * the native drawer caches (accent, power mode).
 */
class PhiBridge(
    private val activity: MainActivity,
    private val origin: String,
) {
    /** Web theme changed (or first applied): repaint this server's badge. */
    @JavascriptInterface
    fun reportThemeColor(key: String, accent: String) {
        activity.onThemeColor(origin, accent)
    }

    /** The server-reported hostname (loadConfig): the identity the rail
     * hashes glyphs from — not the typed URL. */
    @JavascriptInterface
    fun reportHostname(name: String) {
        activity.onHostname(origin, name.trim())
    }

    /** The shell runs low-power ONLY; the page seeds it on load. */
    @JavascriptInterface
    fun lowPowerMode(): Boolean = true
}
