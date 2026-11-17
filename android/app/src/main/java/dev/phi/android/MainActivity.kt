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
import android.webkit.WebChromeClient
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
import androidx.core.view.ViewCompat
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
    private lateinit var stage: FrameLayout
    private lateinit var content: FrameLayout
    private lateinit var panel: LinearLayout
    private lateinit var edgeHandle: View
    private lateinit var edgeChevron: TextView
    private lateinit var serverList: LinearLayout
    private lateinit var zoomLabel: TextView
    private lateinit var store: ServerStore
    private lateinit var profiles: MutableList<ServerProfile>

    private data class Host(
        val view: WebView,
        var lowPowerSeeded: Boolean = false,
    )

    private val hosts = mutableMapOf<String, Host>()
    /** Origins whose last main-frame load failed (diegetic health, rail.css
     * .offline: the chip reads as a disabled tile, not a status block). */
    private val offline = mutableSetOf<String>()

    /** Origins with activity while not active — the rail's attention
     * marker: a lozenge in that server's own accent. phi announces
     * itself through the document title, so a background title change
     * is the "terminal done" signal (WebChromeClient.onReceivedTitle). */
    private val attention = mutableSetOf<String>()
    private var activeId: String? = null
    private var keyboardVisible = false
    private var errorView: LinearLayout? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        profiles = store.load()
        activeId = store.activeId()

        window.navigationBarColor = getColor(R.color.panel)
        // A terminal client must not sleep mid-session; rendering stays
        // low-power via the forced fast-mode + paced rAF, not the screen.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightStatusBars = false

        setContentView(R.layout.activity_main)
        drawer = findViewById(R.id.drawer)
        stage = findViewById(R.id.stage)
        content = findViewById(R.id.content)
        // The zoomed WebView lays out at content/zoom and must re-fill on
        // every content-box change: rotation, IME insets, first measure
        // (content.width is 0 during onCreate).
        var zoomedW = -1
        var zoomedH = -1
        content.viewTreeObserver.addOnGlobalLayoutListener {
            if (content.width != zoomedW || content.height != zoomedH) {
                zoomedW = content.width
                zoomedH = content.height
                if (zoomedW > 0) applyZoomToViews()
            }
        }
        panel = findViewById(R.id.drawerPanel)
        edgeHandle = findViewById(R.id.edgeHandle)
        serverList = findViewById(R.id.serverList)
        edgeChevron = findViewById(R.id.edgeChevron)
        zoomLabel = findViewById(R.id.zoomLabel)

        // Edge-to-edge is enforced at targetSdk 35+; the guideline is to
        // consume insets, not draw under the bars. One listener pads the
        // drawer panel below the status bar and the stage above the nav
        // bar + IME (adjustResize alone no longer moves the window).
        ViewCompat.setOnApplyWindowInsetsListener(drawer) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            panel.setPadding(0, bars.top, 0, 0)
            stage.setPadding(0, bars.top, 0, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        edgeHandle.setOnClickListener { drawer.openDrawer(GravityCompat.START) }
        findViewById<Button>(R.id.addServer).setOnClickListener { promptAddServer() }
        findViewById<Button>(R.id.zoomIn).setOnClickListener { nudgeZoom(true) }
        findViewById<Button>(R.id.zoomOut).setOnClickListener { nudgeZoom(false) }
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
        restyleBrand()
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
        attention.remove(profile.origin)
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
        // Re-assert the shell zoom on every attach: a retained page may
        // have missed the last zoom write (detached views can drop or
        // delay evaluateJavascript), and pages that booted before the
        // zoom was saved never converged. Idempotent on the page side.
        applyZoomToViews()
        refreshActiveRow()
    }

    private fun showEmpty() {
        activeId = null
        store.setActiveId(null)
        content.removeAllViews()
        // web/style.css .empty-state: the Φ mark, "Phi", and the one-line
        // identity — same type scale, no invented copy.
        val layout =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setBackgroundColor(getColor(R.color.bg))
                setPadding(dp(32), dp(32), dp(32), dp(32))
            }
        val accent = getColor(R.color.accent_default)
        val mark =
            TextView(this).apply {
                text = "Φ"
                textSize = 64f // 4.5714rem
                typeface = interGreek
                setTextColor(accent)
                setShadowLayer(30f, 0f, 0f, (accent and 0x00FFFFFF) or (0x26 shl 24))
            }
        val title =
            TextView(this).apply {
                text = "Phi"
                textSize = 26f // 1.8571rem
                typeface = interGreek
                setTextColor(getColor(R.color.text_primary))
                letterSpacing = -0.01f
                setPadding(0, dp(8), 0, 0)
            }
        val subtitle =
            TextView(this).apply {
                text = "Terminal Multiplexer for AI Coding Agents"
                typeface = interLatin
                textSize = 14f
                setTextColor(getColor(R.color.text_muted))
                setPadding(0, dp(4), 0, dp(16))
            }
        layout.addView(mark)
        layout.addView(title)
        layout.addView(subtitle)
        layout.addView(
            TextView(this).apply {
                text = "Add a server from the drawer"
                textSize = 12f
                setTextColor(getColor(R.color.text_muted))
            },
        )
        content.addView(
            layout,
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
        s.userAgentString = "${s.userAgentString} Phi-Android/0.1"
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.setBackgroundColor(getColor(R.color.bg))
        web.addJavascriptInterface(PhiBridge(this, origin), "__phiDesktop")
        web.webViewClient =
            object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    hideLoadError()
                    runOnUiThread {
                        if (offline.remove(origin)) rebuildServerList()
                        applyZoomToViews()
                    }
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
                    if (failingUrl.startsWith(origin)) {
                        runOnUiThread {
                            if (offline.add(origin)) rebuildServerList()
                        }
                        showLoadError()
                    }
                }
            }
        web.webChromeClient =
            object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView, title: String?) {
                    val activeOrigin = profiles.firstOrNull { it.id == activeId }?.origin
                    if (origin != activeOrigin && !title.isNullOrBlank()) {
                        runOnUiThread {
                            if (attention.add(origin)) rebuildServerList()
                        }
                    }
                }
            }
        web.loadUrl(origin)
        return web
    }

    /** Server-reported hostname via /api/config; cached, silent on failure. */
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

    // The rail renders its Greek glyphs in the page's UI font; the brand
    // glyph is JetBrains Mono (web/style.css --font-mono). Static
    // instances of the vendored variable fonts, decompressed from the
    // same woff2 the web client ships.
    private val interGreek: Typeface by lazy {
        Typeface.createFromAsset(assets, "fonts/inter-greek-600.ttf")
    }

    private val interLatin: Typeface by lazy {
        Typeface.createFromAsset(assets, "fonts/inter-latin-400.ttf")
    }

    private val jetbrains: Typeface by lazy {
        Typeface.createFromAsset(assets, "fonts/jetbrains-600.ttf")
    }

    private fun styleChip(
        chip: TextView,
        glyph: String,
        active: Boolean,
        accent: Int?,
        offlineChip: Boolean = false,
    ) {
        chip.text = glyph
        // rail.css .offline (also .offline.active): muted, neutral, no glow.
        val lit = active && accent != null && !offlineChip
        chip.background = chipBackground(lit, if (lit) accent else null)
        // Per-entry accent: every chip that knows its server's colour
        // paints its glyph in it (rail.css --entry-accent on
        // .shortcut-hint, fallback --text); offline chips stay muted.
        chip.setTextColor(
            when {
                offlineChip -> getColor(R.color.text_muted)
                accent != null -> accent
                else -> getColor(R.color.text_primary)
            },
        )
        chip.typeface = interGreek
        // rail.css .rail-item.active: the glyph carries an accent-glow
        // text-shadow (0 0 8px); it is what makes the active server read
        // as lit in that server's own color.
        if (lit) {
            val a = accent!!
            chip.setShadowLayer(dp(8).toFloat(), 0f, 0f, (a and 0x00FFFFFF) or (0x40 shl 24))
        } else {
            chip.setShadowLayer(0f, 0f, 0f, 0)
        }
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
                    typeface = interGreek
                    setTextColor(getColor(R.color.text_primary))
                }
            val url =
                TextView(this).apply {
                    text = p.origin
                    textSize = 12f
                    typeface = interLatin
                    setTextColor(getColor(R.color.text_muted))
                }
            texts.addView(name)
            texts.addView(url)
            row.addView(chip)
            if (p.origin in attention && p.id != activeId) {
                val lozenge =
                    android.view.View(this).apply {
                        background =
                            GradientDrawable().apply {
                                setColor(accent ?: getColor(R.color.text_primary))
                                cornerRadius = dp(1).toFloat()
                            }
                        rotation = 45f
                    }
                val lp = LinearLayout.LayoutParams(dp(8), dp(8))
                lp.leftMargin = -dp(8)
                lp.topMargin = dp(6)
                lp.gravity = Gravity.TOP
                row.addView(lozenge, lp)
            }
            row.addView(texts)
            row.tag = p.id
            row.alpha = if (p.origin in offline) 0.55f else 1f
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

    /** The edge affordance carries the active server's glyph in its own
     * accent — rail identity at a glance while the drawer is shut. */
    private fun restyleEdge() {
        val active = profiles.firstOrNull { it.id == activeId }
        if (active == null) {
            edgeChevron.text = "❮"
            edgeChevron.setTextColor(getColor(R.color.text_muted))
            return
        }
        val (glyph, accent) = glyphFor(active)
        edgeChevron.text = glyph
        edgeChevron.typeface = interGreek
        edgeChevron.setTextColor(accent ?: getColor(R.color.text_primary))
    }

    private fun refreshActiveRow() {
        for (i in 0 until serverList.childCount) {
            val row = serverList.getChildAt(i) as LinearLayout
            val profile = profiles.firstOrNull { it.id == row.tag } ?: continue
            val chip = row.findViewWithTag<TextView>("chip") ?: continue
            val (glyph, accent) = glyphFor(profile)
            styleChip(
                chip,
                glyph,
                row.tag == activeId,
                accent,
                profile.origin in offline,
            )
        }
        // Runs on every switch too, not just full rebuilds - the edge
        // glyph is the active server's identity at a glance.
        restyleEdge()
    }

    /** picker.html parity — the add-server form: field scale, live "Add N
     * servers" label, :7070 autofill, bulk add with per-server errors,
     * paste flattening, Enter submits. */
    private fun promptAddServer() {
        val pad = dp(16)
        val content =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, dp(12), pad, dp(8))
            }
        val title =
            TextView(this).apply {
                text = "Add Phi server"
                textSize = 15f
                typeface = interGreek
                setTextColor(getColor(R.color.text_primary))
                setPadding(0, 0, 0, dp(12))
            }
        val fieldBg =
            GradientDrawable().apply {
                setColor(getColor(R.color.picker_field))
                setStroke(dp(1), getColor(R.color.picker_border))
                cornerRadius = dp(4).toFloat()
            }
        val input =
            EditText(this).apply {
                hint = "https://server.example.com"
                typeface = interLatin
                textSize = 13f
                setTextColor(getColor(R.color.text_primary))
                setHintTextColor(getColor(R.color.text_muted))
                background = fieldBg
                setPadding(dp(10), dp(8), dp(10), dp(8))
                inputType =
                    android.text.InputType.TYPE_CLASS_TEXT or
                        android.text.InputType.TYPE_TEXT_VARIATION_URI
                imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
                setSingleLine()
            }
        input.onFocusChangeListener =
            View.OnFocusChangeListener { _, has ->
                fieldBg.setStroke(
                    dp(1),
                    getColor(
                        if (has) R.color.picker_accent else R.color.picker_border,
                    ),
                )
            }
        val error =
            TextView(this).apply {
                textSize = 12f
                setTextColor(getColor(R.color.picker_error))
                setPadding(0, dp(8), 0, 0)
                visibility = View.GONE
            }
        content.addView(title)
        content.addView(input)
        content.addView(error)

        fun btn(label: String, accent: Boolean, onClick: () -> Unit) =
            android.widget.Button(this).apply {
                text = label
                textSize = 13f
                setTextColor(getColor(R.color.text_primary))
                background =
                    GradientDrawable().apply {
                        setColor(
                            getColor(
                                if (accent) R.color.picker_accent else R.color.picker_btn_bg,
                            ),
                        )
                        setStroke(
                            dp(1),
                            getColor(
                                if (accent) R.color.picker_accent else R.color.picker_border,
                            ),
                        )
                        cornerRadius = dp(4).toFloat()
                    }
                setPadding(dp(16), dp(6), dp(16), dp(6))
                minHeight = 0
                minimumHeight = 0
                setOnClickListener { onClick() }
            }

        val dialog =
            AlertDialog.Builder(this)
                .setView(content)
                .create()

        fun urls() = ServerInput.parseUrls(input.text.toString())

        val add = btn("Add", accent = true) {}
        fun submit() {
            val parsed = urls()
            if (parsed.isEmpty()) {
                error.text = "Invalid server URL"
                error.visibility = View.VISIBLE
                return
            }
            val errors = mutableListOf<String>()
            var added: ServerProfile? = null
            for (url in parsed) {
                normalizeServerUrl(url)
                    .onSuccess { origin ->
                        if (profiles.none { it.origin == origin }) {
                            val profile =
                                ServerProfile(store.newId(), defaultLabelFor(origin), origin)
                            profiles.add(profile)
                            added = profile
                        }
                    }
                    .onFailure { e -> errors.add("$url: ${e.message}") }
            }
            store.save(profiles)
            rebuildServerList()
            if (errors.isNotEmpty()) {
                error.text = errors.joinToString("; ")
                error.visibility = View.VISIBLE
                add.text = if (urls().size > 1) "Add ${urls().size} servers" else "Add"
                return
            }
            dialog.dismiss()
            (added ?: profiles.lastOrNull())?.let { showServer(it.id) }
        }
        add.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) {
                submit()
                true
            } else {
                false
            }
        }
        // picker.html paste flattening: newlines become spaces.
        input.addTextChangedListener(
            object : android.text.TextWatcher {
                override fun beforeTextChanged(
                    s: CharSequence?,
                    a: Int,
                    b: Int,
                    c: Int,
                ) {}

                override fun onTextChanged(
                    s: CharSequence?,
                    a: Int,
                    b: Int,
                    c: Int,
                ) {}

                override fun afterTextChanged(s: android.text.Editable?) {
                    val t = s?.toString().orEmpty()
                    if (Regex("[\r\n]").containsMatchIn(t)) {
                        val flat = t.replace(Regex("[\r\n]+"), " ").trim()
                        input.setText(flat)
                        input.setSelection(flat.length)
                        return
                    }
                    val n = ServerInput.parseUrls(t).size
                    add.text = if (n > 1) "Add $n servers" else "Add"
                }
            },
        )

        val footer =
            LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
                setPadding(0, dp(12), 0, 0)
            }
        val copyAll =
            TextView(this).apply {
                text = "Copy all server URLs"
                textSize = 12f
                setTextColor(getColor(R.color.text_muted))
                setPadding(0, 0, dp(16), 0)
                setOnClickListener {
                    val clip =
                        android.content.ClipData.newPlainText(
                            "phi servers",
                            profiles.joinToString("\n") { it.origin },
                        )
                    val cm = getSystemService(android.content.ClipboardManager::class.java)
                    cm?.setPrimaryClip(clip)
                }
            }
        footer.addView(
            copyAll,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        footer.addView(
            btn("Cancel", accent = false) { dialog.dismiss() },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        (dp(8)).let { footer.addView(android.view.View(this), LinearLayout.LayoutParams(it, 1)) }
        footer.addView(
            add,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        content.addView(footer)
        dialog.show()
    }

    private fun promptEditServer(profile: ServerProfile) {
        val identity =
            GreekGlyph.canonicalHostname(store.displayNameFor(profile.origin))
                .ifEmpty { profile.label }
        val pad = dp(16)
        val sheet =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, dp(12), pad, dp(8))
            }
        sheet.addView(
            TextView(this).apply {
                text = identity
                textSize = 15f
                typeface = interGreek
                setTextColor(getColor(R.color.text_primary))
                setPadding(0, 0, 0, dp(4))
            },
        )
        sheet.addView(
            TextView(this).apply {
                text = profile.origin
                textSize = 12f
                typeface = interLatin
                setTextColor(getColor(R.color.text_muted))
                setPadding(0, 0, 0, dp(12))
            },
        )
        val dialog = AlertDialog.Builder(this).setView(sheet).create()
        fun row(label: String, onClick: () -> Unit) =
            TextView(this).apply {
                text = label
                textSize = 14f
                setTextColor(getColor(R.color.text_primary))
                background =
                    GradientDrawable().apply {
                        setColor(getColor(R.color.bg_elevated))
                        setStroke(dp(1), getColor(R.color.bg_border))
                        cornerRadius = dp(6).toFloat()
                    }
                setPadding(dp(12), dp(12), dp(12), dp(12))
                gravity = Gravity.CENTER
                setOnClickListener {
                    dialog.dismiss()
                    onClick()
                }
            }
        val actions =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
            }
        actions.addView(row("Rename") { promptRename(profile) })
        actions.addView(android.view.View(this), LinearLayout.LayoutParams(1, dp(8)))
        actions.addView(
            row("Remove") {
                hosts.remove(profile.origin)?.view?.destroy()
                profiles.removeAll { it.id == profile.id }
                store.save(profiles)
                rebuildServerList()
                if (activeId == profile.id) {
                    profiles.firstOrNull()?.let { showServer(it.id) } ?: showEmpty()
                }
            },
        )
        sheet.addView(actions)
        dialog.show()
    }

    private fun promptRename(profile: ServerProfile) {
        val input =
            EditText(this).apply {
                setText(profile.label)
                textSize = 13f
                setTextColor(getColor(R.color.text_primary))
                background =
                    GradientDrawable().apply {
                        setColor(getColor(R.color.picker_field))
                        setStroke(dp(1), getColor(R.color.picker_border))
                        cornerRadius = dp(4).toFloat()
                    }
                setPadding(dp(10), dp(8), dp(10), dp(8))
                setSingleLine()
            }
        val wrap = LinearLayout(this).apply { setPadding(dp(16), dp(8), dp(16), dp(4)) }
        wrap.addView(input)
        AlertDialog.Builder(this)
            .setTitle("Rename server")
            .setView(wrap)
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

    /** Bridge callback: the server-reported hostname — the identity the
     *  glyphs hash. Repaints rows, shortcuts and the edge glyph. */
    fun onHostname(origin: String, name: String) {
        if (name.isEmpty()) return
        if (store.displayNameFor(origin) == name) return
        store.setDisplayName(origin, name)
        runOnUiThread {
            rebuildServerList()
        }
    }

    /** Bridge callback: the web accent changed; cache it and repaint badges live. */
    fun onThemeColor(origin: String, accent: String) {
        if (!Regex("^#[0-9a-fA-F]{6}$").matches(accent)) return
        store.setAccent(origin, accent)
        runOnUiThread {
            rebuildServerList()
            restyleBrand()
        }
    }

    /** .brand .logo: the Φ rides the active accent with a soft glow. */
    private fun restyleBrand() {
        val glyph = findViewById<TextView>(R.id.brandGlyph) ?: return
        val active = profiles.firstOrNull { it.id == activeId }
        val accent =
            active?.origin?.let { store.accentFor(it) }?.let {
                try {
                    Color.parseColor(it)
                } catch (e: Exception) {
                    null
                }
            } ?: getColor(R.color.accent_default)
        glyph.typeface = jetbrains
        glyph.setTextColor(accent)
        glyph.setShadowLayer(10f, 0f, 0f, (accent and 0x00FFFFFF) or 0x26 shl 24)
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

    /** Zoom drives phi's own mobile appearance (terminal + ui font), so
     *  xterm re-measures its cells and the grid reflows - textZoom only
     *  rescaled pixels and left the terminal at stale cols/rows. 100% is
     *  phi's fallback 14px; the page clamps to its own 8..32 bounds. */
    private fun setZoom(z: Int) {
        store.setZoom(z)
        applyZoomToViews()
        refreshZoomLabel()
    }

    /** Desktop parity (electron/src/zoom.ts applyContentZoom): zoom is a
     * page scale factor, never a font-size change. The WebView lays out
     * at content/zoom CSS pixels and the view is counter-scaled back to
     * full bleed - the browser-zoom model done for real: the layout
     * viewport genuinely changes, the page reflows, and xterm
     * re-measures its cells and refits cols/rows. CSS zoom on the root
     * cannot do this (it scales the painted box without reflow - a
     * shrunken "box" with dead margins). */
    private fun applyZoomToViews() {
        val z = store.zoom() / 100f
        val w = content.width.coerceAtLeast(1)
        val h = content.height.coerceAtLeast(1)
        for (host in hosts.values) {
            val v = host.view
            val lp = v.layoutParams as FrameLayout.LayoutParams
            lp.width = Math.round(w / z)
            lp.height = Math.round(h / z)
            v.layoutParams = lp
            v.pivotX = 0f
            v.pivotY = 0f
            v.scaleX = z
            v.scaleY = z
        }
    }

    /** CONTENT_ZOOM_LEVELS parity: 50 67 75 80 90 100 110 125 150 175 200
     * 250 300 - the desktop ladder, walked by nextContentZoomPercent. */
    private fun nextZoom(current: Int, up: Boolean): Int {
        val levels = intArrayOf(50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300)
        val exact = levels.indexOfFirst { it == current }
        val i =
            when {
                exact >= 0 -> (exact + if (up) 1 else -1).coerceIn(0, levels.size - 1)
                else -> {
                    val hi = levels.indexOfFirst { it > current }
                    if (hi < 0) levels.size - 1
                    else if (up) hi
                    else (hi - 1).coerceIn(0, levels.size - 1)
                }
            }
        return levels[i]
    }

    private fun nudgeZoom(up: Boolean) = setZoom(nextZoom(store.zoom(), up))

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
