package dev.phi.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.Color
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.GravityCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.drawerlayout.widget.DrawerLayout
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Phi Android shell: one retained WebView per server, swapped on tap
 * (desktop retain-and-swap). The web client renders everything; this
 * activity owns the drawer, profiles, zoom, and back behavior only.
 */
class MainActivity : ComponentActivity() {
    private lateinit var drawer: DrawerLayout
    private lateinit var content: FrameLayout
    private lateinit var panel: LinearLayout
    private lateinit var edgeHandle: View
    private lateinit var serverList: LinearLayout
    private lateinit var zoomLabel: TextView
    private lateinit var store: ServerStore
    private lateinit var profiles: MutableList<ServerProfile>

    private data class Host(
        val view: WebView,
        var lowPowerSeeded: Boolean = false,
    )

    private val hosts = mutableMapOf<String, Host>()
    private var activeId: String? = null
    private var keyboardVisible = false
    private var errorView: LinearLayout? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        profiles = store.load()
        activeId = store.activeId()

        window.statusBarColor = getColor(R.color.panel)
        window.navigationBarColor = getColor(R.color.panel)
        // A terminal client must not sleep mid-session; rendering stays
        // low-power via the forced fast-mode + paced rAF, not the screen.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightStatusBars = false

        setContentView(R.layout.activity_main)
        drawer = findViewById(R.id.drawer)
        content = findViewById(R.id.content)
        panel = findViewById(R.id.drawerPanel)
        edgeHandle = findViewById(R.id.edgeHandle)
        serverList = findViewById(R.id.serverList)
        zoomLabel = findViewById(R.id.zoomLabel)

        edgeHandle.setOnClickListener { drawer.openDrawer(GravityCompat.START) }
        findViewById<Button>(R.id.addServer).setOnClickListener { promptAddServer() }
        findViewById<Button>(R.id.zoomIn).setOnClickListener { nudgeZoom(10) }
        findViewById<Button>(R.id.zoomOut).setOnClickListener { nudgeZoom(-10) }
        zoomLabel.setOnClickListener { setZoom(100) }
        refreshZoomLabel()

        drawer.addDrawerListener(
            object : DrawerLayout.SimpleDrawerListener() {
                override fun onDrawerSlide(drawerView: View, slideOffset: Float) {
                    val w = panel.width.toFloat()
                    edgeHandle.translationX = slideOffset * w
                    edgeHandle.alpha = (1f - slideOffset * 0.7f) *
                        if (keyboardVisible) 0f else 1f
                }

                override fun onDrawerOpened(drawerView: View) {
                    // intentionally no blur (see note above)
                }

                override fun onDrawerClosed(drawerView: View) {
                }
            },
        )

        content.viewTreeObserver.addOnGlobalLayoutListener {
            val insets =
                androidx.core.view.ViewCompat
                    .getRootWindowInsets(content)
                    ?.getInsets(WindowInsetsCompat.Type.ime())
            val imeVisible = (insets?.bottom ?: 0) > 0
            if (imeVisible != keyboardVisible) {
                keyboardVisible = imeVisible
                edgeHandle.alpha = if (imeVisible) 0f else 1f
                edgeHandle.isClickable = !imeVisible
            }
        }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (drawer.isDrawerOpen(GravityCompat.START)) {
                        drawer.closeDrawer(GravityCompat.START)
                        return
                    }
                    currentHost()?.view?.let {
                        if (it.canGoBack()) {
                            it.goBack()
                            return
                        }
                    }
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            },
        )

        rebuildServerList()
        refreshShortcuts()
        val start =
            intent?.getStringExtra("phi_server_id")?.let { id ->
                profiles.firstOrNull { it.id == id }
            } ?: profiles.firstOrNull { it.id == activeId }
                ?: profiles.firstOrNull()
        if (start != null) showServer(start.id) else showEmpty()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra("phi_server_id")?.let { id ->
            if (profiles.any { it.id == id }) {
                drawer.closeDrawer(GravityCompat.START)
                showServer(id)
            }
        }
    }

    // ---------- servers ----------

    private fun currentHost(): Host? =
        profiles.firstOrNull { it.id == activeId }?.origin?.let { hosts[it] }

    private fun showServer(id: String) {
        val profile = profiles.firstOrNull { it.id == id } ?: return
        activeId = id
        store.setActiveId(id)
        var host = hosts[profile.origin]
        if (host == null) {
            host = Host(makeWebView(profile.origin))
            hosts[profile.origin] = host
        }
        content.removeAllViews()
        errorView = null
        content.addView(
            host.view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        refreshActiveRow()
        refreshDisplayName(profile)
    }

    private fun showEmpty() {
        activeId = null
        store.setActiveId(null)
        content.removeAllViews()
        val hint =
            TextView(this).apply {
                text = "Add a Phi server from the drawer to begin."
                setTextColor(getColor(R.color.text_muted))
                textSize = 16f
                gravity = Gravity.CENTER
                setPadding(48, 48, 48, 48)
            }
        content.addView(
            hint,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        refreshActiveRow()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(origin: String): WebView {
        val web = WebView(this)
        val s: WebSettings = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.textZoom = store.zoom()
        s.userAgentString = "${s.userAgentString} Phi-Android/0.1"
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.setBackgroundColor(getColor(R.color.panel))
        web.addJavascriptInterface(PhiBridge(this, origin), "__phiDesktop")
        web.webViewClient =
            object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    hideLoadError()
                    // Mirror desktop low-power: page boots full; native
                    // forces the ONLY mode just after load.
                    if (url.startsWith(origin)) {
                        view.evaluateJavascript(
                            "try{localStorage.setItem('phi_low_power','1');" +
                                "document.documentElement.classList.add('fast-mode');}catch(e){}",
                            null,
                        )
                    }
                }

                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    val url = request.url ?: return null
                    if (!request.isForMainFrame && request.method != "GET") return null
                    if (url.scheme != "http" && url.scheme != "https") return null
                    if (url.toString().startsWith("$origin/api")) return null
                    var p = url.encodedPath ?: return null
                    if (p == "/") p = "/index.html"
                    if (p.contains("..")) return null
                    return try {
                        val stream = view.context.assets.open(p.trimStart('/'))
                        WebResourceResponse(mimeFor(p), "utf-8", 200, "OK", mapOf(), stream)
                    } catch (e: Exception) {
                        null // Not vendored: fall through to the network.
                    }
                }

                override fun onReceivedError(
                    view: WebView,
                    errorCode: Int,
                    description: String,
                    failingUrl: String,
                ) {
                    if (failingUrl.startsWith(origin)) showLoadError()
                }
            }
        web.loadUrl(origin)
        return web
    }

    /** Server-reported hostname via /api/config; cached, silent on failure. */
    private fun refreshDisplayName(profile: ServerProfile) {
        thread(isDaemon = true) {
            try {
                val conn = URL("${profile.origin}/api/config").openConnection()
                    as HttpURLConnection
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                CookieManager.getInstance()
                    ?.getCookie(profile.origin)
                    ?.let { conn.setRequestProperty("Cookie", it) }
                if (conn.responseCode != 200) return@thread
                val body = conn.inputStream.bufferedReader().readText()
                val name =
                    Regex("\"hostname\"\\s*:\\s*\"([^\"]+)\"")
                        .find(body)?.groupValues?.get(1)
                        ?.takeIf { it.isNotBlank() } ?: return@thread
                runOnUiThread {
                    store.setDisplayName(profile.origin, name)
                    rebuildServerList()
                }
            } catch (e: Exception) {
                // Offline / auth / unknown shape: pretty host stands in.
            }
        }
    }

    /** Glyph + accent for a server: renderer.ts parity — the glyph hashes
     * the canonical hostname, the accent is the page-reported one (else null:
     * the rail carries no default color). */
    private fun glyphFor(profile: ServerProfile): Pair<String, Int?> {
        val glyph = GreekGlyph.forHostname(
            GreekGlyph.canonicalHostname(store.displayNameFor(profile.origin))
                .ifEmpty { profile.label },
        )
        val accent =
            store.accentFor(profile.origin)?.let {
                try {
                    Color.parseColor(it)
                } catch (e: Exception) {
                    null
                }
            }
        return Pair(glyph, accent)
    }

    /** rail-item material (rail.css): elevated tile, 6dp radius, 1dp border.
     * Active + observed accent: accent-glow fill, accent stroke and glyph —
     * no-accent mode keeps the neutral material (rail.css .no-accent). */
    private fun chipBackground(active: Boolean, accent: Int?): GradientDrawable {
        val fill =
            if (active && accent != null) {
                (accent and 0x00FFFFFF) or (0x26 shl 24) // accent @ 15% (glow)
            } else {
                getColor(R.color.bg_elevated)
            }
        val stroke = if (active && accent != null) accent else getColor(R.color.bg_border)
        return GradientDrawable().apply {
            setColor(fill)
            setStroke(dp(1), stroke)
            cornerRadius = dp(6).toFloat()
        }
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt()

    private fun styleChip(
        chip: TextView,
        glyph: String,
        active: Boolean,
        accent: Int?,
    ) {
        chip.text = glyph
        chip.background = chipBackground(active, accent)
        chip.setTextColor(
            if (active && accent != null) accent else getColor(R.color.text_primary),
        )
        chip.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD)) // rail glyphs are 600
    }

    private fun rebuildServerList() {
        serverList.removeAllViews()
        for (p in profiles) {
            val (glyph, accent) = glyphFor(p)
            // renderer.ts identityLabel: canonical hostname when observed,
            // else the profile name.
            val identity =
                GreekGlyph.canonicalHostname(store.displayNameFor(p.origin))
                    .ifEmpty { p.label }
            val row =
                LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = android.view.Gravity.CENTER_VERTICAL
                    setPadding(dp(16), dp(8), dp(16), dp(8))
                    isClickable = true
                    isFocusable = true
                    foreground = obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackground))
                        .getDrawable(0)
                }
            val chip =
                TextView(this).apply {
                    gravity = Gravity.CENTER
                    textSize = 14f
                    layoutParams = LinearLayout.LayoutParams(dp(40), dp(40))
                    tag = "chip"
                }
            val texts =
                LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(16), 0, 0, 0)
                    layoutParams =
                        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                }
            val name =
                TextView(this).apply {
                    text = identity
                    textSize = 15f
                    setTextColor(getColor(R.color.text_primary))
                }
            val url =
                TextView(this).apply {
                    text = p.origin
                    textSize = 12f
                    setTextColor(getColor(R.color.text_muted))
                }
            texts.addView(name)
            texts.addView(url)
            row.addView(chip)
            row.addView(texts)
            row.tag = p.id
            row.setOnClickListener {
                drawer.closeDrawer(GravityCompat.START)
                showServer(p.id)
            }
            row.setOnLongClickListener { promptEditServer(p); true }
            serverList.addView(row)
        }
        refreshActiveRow()
        refreshShortcuts()
    }

    private fun refreshActiveRow() {
        for (i in 0 until serverList.childCount) {
            val row = serverList.getChildAt(i) as LinearLayout
            val profile = profiles.firstOrNull { it.id == row.tag } ?: continue
            val chip = row.findViewWithTag<TextView>("chip") ?: continue
            val (glyph, accent) = glyphFor(profile)
            styleChip(chip, glyph, row.tag == activeId, accent)
        }
    }

    private fun promptAddServer() {
        val input = EditText(this).apply { hint = "https://server.example.com" }
        AlertDialog.Builder(this)
            .setTitle("Add server")
            .setView(input)
            .setPositiveButton("Add") { _, _ ->
                val res = normalizeServerUrl(input.text.toString())
                res.onSuccess { origin ->
                    val profile =
                        ServerProfile(store.newId(), defaultLabelFor(origin), origin)
                    profiles.add(profile)
                    store.save(profiles)
                    rebuildServerList()
                    showServer(profile.id)
                }.onFailure { e ->
                    AlertDialog.Builder(this)
                        .setMessage(e.message)
                        .setPositiveButton("OK", null)
                        .show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun promptEditServer(profile: ServerProfile) {
        AlertDialog.Builder(this)
            .setTitle(store.displayNameFor(profile.origin))
            .setItems(arrayOf("Rename", "Remove")) { _, which ->
                when (which) {
                    0 -> {
                        val input = EditText(this).apply { setText(profile.label) }
                        AlertDialog.Builder(this)
                            .setTitle("Rename server")
                            .setView(input)
                            .setPositiveButton("Save") { _, _ ->
                                val label = input.text.toString().trim()
                                if (label.isNotEmpty()) {
                                    profiles.replaceAll {
                                        if (it.id == profile.id) it.copy(label = label) else it
                                    }
                                    store.save(profiles)
                                    rebuildServerList()
                                }
                            }
                            .setNegativeButton("Cancel", null)
                            .show()
                    }
                    1 -> {
                        hosts.remove(profile.origin)?.view?.destroy()
                        profiles.removeAll { it.id == profile.id }
                        store.save(profiles)
                        rebuildServerList()
                        if (activeId == profile.id) {
                            profiles.firstOrNull()?.let { showServer(it.id) } ?: showEmpty()
                        }
                    }
                }
            }
            .show()
    }

    /** Bridge callback: the web accent changed; cache it and repaint badges live. */
    fun onThemeColor(origin: String, accent: String) {
        if (!Regex("^#[0-9a-fA-F]{6}$").matches(accent)) return
        store.setAccent(origin, accent)
        runOnUiThread { rebuildServerList() }
    }

    private fun showLoadError() {
        runOnUiThread {
            if (errorView != null) return@runOnUiThread
            val origin =
                profiles.firstOrNull { it.id == activeId }?.origin
                    ?: return@runOnUiThread
            val layout =
                LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    setBackgroundColor(getColor(R.color.panel))
                    setPadding(48, 48, 48, 48)
                }
            val title =
                TextView(this).apply {
                    text = "Server unreachable"
                    textSize = 18f
                    setTextColor(getColor(R.color.text_primary))
                    gravity = Gravity.CENTER
                }
            val sub =
                TextView(this).apply {
                    text = origin
                    textSize = 13f
                    setTextColor(getColor(R.color.text_muted))
                    gravity = Gravity.CENTER
                    setPadding(0, 16, 0, 32)
                }
            val retry =
                Button(this).apply {
                    text = "Retry"
                    setOnClickListener {
                        hideLoadError()
                        currentHost()?.view?.reload()
                    }
                }
            layout.addView(title)
            layout.addView(sub)
            layout.addView(retry)
            content.addView(
                layout,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
            errorView = layout
        }
    }

    private fun hideLoadError() {
        errorView?.let { content.removeView(it) }
        errorView = null
    }

    /** Shortcut icon: a rail chip rendered to bitmap (elevated tile, glyph). */
    private fun chipBitmap(glyph: String): Bitmap {
        val px = 192
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        chipBackground(active = false, accent = null).apply {
            setBounds(0, 0, px, px)
            draw(canvas)
        }
        val paint =
            android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                color = getColor(R.color.text_primary)
                textAlign = android.graphics.Paint.Align.CENTER
                textSize = px * 14f / 40f
                isFakeBoldText = true
            }
        val cy = px / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(glyph, px / 2f, cy, paint)
        return bmp
    }

    /** Launcher long-press shortcuts: first four servers, badge icons. */
    private fun refreshShortcuts() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return
        val sm = getSystemService(ShortcutManager::class.java) ?: return
        sm.dynamicShortcuts =
            profiles.take(4).map { p ->
                val (glyph, _) = glyphFor(p)
                ShortcutInfo.Builder(this, "server:${p.id}")
                    .setShortLabel(
                        GreekGlyph.canonicalHostname(store.displayNameFor(p.origin))
                            .ifEmpty { p.label }.take(12),
                    )
                    .setLongLabel(p.origin)
                    .setIcon(Icon.createWithBitmap(chipBitmap(glyph)))
                    .setIntent(
                        Intent(this, MainActivity::class.java)
                            .setAction("phi.OPEN")
                            .putExtra("phi_server_id", p.id),
                    )
                    .build()
            }
    }

    // ---------- zoom ----------

    private fun setZoom(z: Int) {
        store.setZoom(z)
        for (h in hosts.values) h.view.settings.textZoom = store.zoom()
        refreshZoomLabel()
    }

    private fun nudgeZoom(delta: Int) = setZoom(store.zoom() + delta)

    private fun refreshZoomLabel() {
        zoomLabel.text = "${store.zoom()}%"
    }

    // ---------- glass ----------

    // No live blur: RenderEffect on the panel blurs the panel's own
    // contents (unreadable rows), and blurring the WebView behind the
    // drawer costs real GPU on a phone chip. The obsidian glass fill +
    // hairline does the job at zero cost.

    companion object {
        private fun mimeFor(path: String): String =
            when (substringAfterLastDot(path)) {
                "html" -> "text/html"
                "js", "mjs" -> "text/javascript"
                "css" -> "text/css"
                "json", "map" -> "application/json"
                "svg" -> "image/svg+xml"
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "gif" -> "image/gif"
                "webp" -> "image/webp"
                "ico" -> "image/x-icon"
                "woff" -> "font/woff"
                "woff2" -> "font/woff2"
                "ttf" -> "font/ttf"
                "otf" -> "font/otf"
                "wasm" -> "application/wasm"
                "pdf" -> "application/pdf"
                "mp3" -> "audio/mpeg"
                "mp4" -> "video/mp4"
                "wav" -> "audio/wav"
                else -> "application/octet-stream"
            }

        private fun substringAfterLastDot(path: String): String =
            path.substringAfterLast('.', "").lowercase()
    }
}
