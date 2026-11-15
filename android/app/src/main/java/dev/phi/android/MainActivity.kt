package dev.phi.android

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.navigation.NavigationView

/**
 * v0.2 shell: native NavigationDrawer for backend switching + one retained
 * WebView per saved server origin. No hardcoded URL — first run opens the
 * drawer with an "add server" affordance. Low power is the only mode
 * (seeded per origin; the web app's mobile gate forces it anyway).
 */
class MainActivity : Activity() {

    private lateinit var store: ServerStore
    private val profiles = mutableListOf<ServerProfile>()
    private val views = mutableMapOf<String, WebView>()

    private lateinit var drawer: DrawerLayout
    private lateinit var navView: NavigationView
    private lateinit var content: FrameLayout
    private lateinit var edgeHandle: View
    private var activeId: String? = null

    private val uiHandler = Handler(Looper.getMainLooper())
    private val fadeHandle = Runnable { edgeHandle.animate().alpha(0.4f).setDuration(300).start() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawableResource(android.R.color.black)
        store = ServerStore(this)
        profiles.addAll(store.load())

        buildLayout()
        rebuildDrawer()
        wireInsets()

        val start = store.activeId()?.takeIf { id -> profiles.any { it.id == id } }
            ?: profiles.firstOrNull()?.id
        if (start != null) {
            selectProfile(start, fromUser = false)
        } else {
            drawer.openDrawer(GravityCompat.START)
            Toast.makeText(this, "Add your Phi server to begin", Toast.LENGTH_LONG).show()
        }
    }

    // ---------- layout ----------

    private fun buildLayout() {
        drawer = DrawerLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(0xFF000000.toInt())
        }
        content = FrameLayout(this).apply {
            layoutParams = DrawerLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        drawer.addView(content)

        // Edge handle: small native pill that opens the drawer (no app bar).
        edgeHandle = View(this).apply {
            val w = (48 * resources.displayMetrics.density).toInt()
            val h = (64 * resources.displayMetrics.density).toInt()
            layoutParams = FrameLayout.LayoutParams(w, h, Gravity.START or Gravity.CENTER_VERTICAL)
            setBackgroundResource(android.R.drawable.dialog_holo_light_frame)
            alpha = 0.7f
            isClickable = true
            isFocusable = true
            setOnClickListener { drawer.openDrawer(GravityCompat.START) }
        }
        content.addView(edgeHandle)

        navView = NavigationView(this).apply {
            val width = ((resources.displayMetrics.widthPixels - 56 * resources.displayMetrics.density)
                .toInt()).coerceAtMost((360 * resources.displayMetrics.density).toInt())
            layoutParams = DrawerLayout.LayoutParams(
                width,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.START,
            )
            fitsSystemWindows = true
            inflateHeaderView(R.layout.drawer_header)
            setNavigationItemSelectedListener { item ->
                if (item.groupId == GROUP_FOOTER && item.itemId == ITEM_ADD) {
                    showAddDialog()
                } else {
                    itemIdToProfile(item.itemId)?.let { selectProfile(it, fromUser = true) }
                }
                drawer.closeDrawer(GravityCompat.START)
                true
            }
        }
        drawer.addView(navView)

        // Touch anywhere resets the edge-handle idle fade.

        setContentView(drawer)
    }

    private fun pokeHandle() {
        edgeHandle.animate().cancel()
        edgeHandle.alpha = 0.7f
        uiHandler.removeCallbacks(fadeHandle)
        uiHandler.postDelayed(fadeHandle, 3000)
    }

    private fun wireInsets() {
        // Hide the edge handle while the keyboard is up (it would float
        // over the IME); fade it when idle otherwise.
        drawer.setOnApplyWindowInsetsListener { _, insets ->
            val imeVisible = if (Build.VERSION.SDK_INT >= 30) {
                insets.isVisible(WindowInsets.Type.ime())
            } else {
                false
            }
            edgeHandle.visibility = if (imeVisible) View.GONE else View.VISIBLE
            if (!imeVisible) pokeHandle()
            insets
        }
        pokeHandle()
    }

    // ---------- drawer ----------

    private fun rebuildDrawer() {
        val menu = navView.menu
        menu.clear()
        itemToProfile.clear()
        for ((index, p) in profiles.withIndex()) {
            val itemId = p.id.hashCode()
            itemToProfile[itemId] = p.id
            val shown = if (p.label == defaultLabelFor(p.origin)) p.origin else "${p.label} · ${shortOrigin(p.origin)}"
            menu.add(GROUP_SERVERS, itemId, index, shown).apply {
                isCheckable = true
                isChecked = p.id == activeId
            }
        }
        menu.add(GROUP_FOOTER, ITEM_ADD, profiles.size + 1, "+ Add server").apply {
            isCheckable = false
        }
        // Long-press handling per row is wired through the menu view below.
        wireRowLongPress()
    }

    private val itemToProfile = mutableMapOf<Int, String>()
    private fun itemIdToProfile(itemId: Int): String? = itemToProfile[itemId]

    private fun wireRowLongPress() {
        // NavigationView internals: first child is NavigationMenuView (a list).
        val list = navView.getChildAt(0) as? ViewGroup ?: return
        // Walk rendered rows; tag each with its profile id for long-press.
        // Rows render in menu order: servers first, footer last.
        var row = 0
        for (i in 0 until list.childCount) {
            val child = list.getChildAt(i)
            if (child.javaClass.simpleName.contains("NavigationMenuItemView")) {
                if (row < profiles.size) {
                    val pid = profiles[row].id
                    child.setOnLongClickListener {
                        showProfileDialog(pid)
                        true
                    }
                }
                row++
            }
        }
    }

    private fun shortOrigin(origin: String): String {
        val u = android.net.Uri.parse(origin)
        val port = if (u.port != -1) ":${u.port}" else ""
        return "${u.host}$port"
    }

    // ---------- profiles ----------

    private fun selectProfile(id: String, fromUser: Boolean) {
        val profile = profiles.find { it.id == id } ?: return
        activeId = id
        store.setActiveId(id)
        for (i in 0 until navView.menu.size()) {
            val item = navView.menu.getItem(i)
            if (item.groupId == GROUP_SERVERS) {
                item.isChecked = itemToProfile[item.itemId] == id
            }
        }
        // Retain one warm WebView per origin; swap visibility, never reload.
        var view = views[id]
        if (view == null) {
            view = makeWebView(profile)
            views[id] = view
            content.addView(view, 0)
        }
        for ((pid, w) in views) {
            w.visibility = if (pid == id) View.VISIBLE else View.GONE
        }
        if (fromUser) Toast.makeText(this, profile.label, Toast.LENGTH_SHORT).show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(profile: ServerProfile): WebView {
        return WebView(this).apply {
            setBackgroundColor(0xFF000000.toInt())
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            settings.apply {
                javaScriptEnabled = true
                // REQUIRED: low power + sidebar state live in localStorage.
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                loadWithOverviewMode = true
                useWideViewPort = true
                builtInZoomControls = false
                displayZoomControls = false
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = false
                /**
                 * Local store of the web files: same-origin static GETs are
                 * served from the APK's vendored copy (synced from
                 * desktop/electron/embedded/ at build time — the same bytes
                 * the desktop embeds). Page URL stays on the server origin,
                 * so /api, /ws, cookies, and per-origin localStorage work
                 * untouched. Anything not vendored falls through to network.
                 */
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    if (request.method != "GET") return null
                    val url = request.url ?: return null
                    if (url.scheme != "http" && url.scheme != "https") return null
                    val active = profiles.find { it.id == activeId } ?: return null
                    if ("${url.scheme}://${url.authority}" != active.origin) return null
                    var p = url.path ?: return null
                    if (p == "/api" || p.startsWith("/api/")) return null
                    if (p == "/") p = "/index.html"
                    if (p.contains("..")) return null
                    // assets.srcDir points AT www/, so its contents are the
                    // assets root: strip the leading slash for open().
                    val assetName = p.trimStart('/')
                    return try {
                        val stream = view.context.assets.open(assetName)
                        val textExts = setOf("html", "css", "js", "mjs", "json", "svg", "map", "txt", "md")
                        val ext = p.substringAfterLast('.', "").lowercase()
                        WebResourceResponse(mimeForPath(p), if (ext in textExts) "UTF-8" else null, stream)
                    } catch (e: Exception) {
                        null
                    }
                }
                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    view.evaluateJavascript(
                        "(function(){try{" +
                            "localStorage.setItem('phi_low_power','1');" +
                            "document.body.classList.add('fast-mode');" +
                            "}catch(e){}})();",
                        null,
                    )
                }
            }
            webChromeClient = WebChromeClient()
            loadUrl(profile.origin)
        }
    }

    private fun showAddDialog() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = "http://mymachine:7070"
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(input, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Add server")
            .setView(box)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Add", null)
            .show()
            .also { dialog ->
                dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                    ?.setOnClickListener {
                        normalizeServerUrl(input.text.toString())
                            .onSuccess { origin ->
                                if (profiles.any { it.origin == origin }) {
                                    input.error = "Already added"
                                    return@onSuccess
                                }
                                val profile = ServerProfile(
                                    store.newId(), defaultLabelFor(origin), origin,
                                )
                                profiles.add(profile)
                                store.save(profiles)
                                rebuildDrawer()
                                selectProfile(profile.id, fromUser = true)
                                dialog.dismiss()
                            }
                            .onFailure { e -> input.error = e.message }
                    }
            }
    }

    private fun showProfileDialog(pid: String) {
        val profile = profiles.find { it.id == pid } ?: return
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(profile.label)
            selectAll()
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(input, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(shortOrigin(profile.origin))
            .setView(box)
            .setNeutralButton("Remove") { _, _ -> confirmRemove(pid) }
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Rename", null)
            .show()
            .also { dialog ->
                dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                    ?.setOnClickListener {
                        val name = input.text.toString().trim()
                        if (name.isEmpty()) {
                            input.error = "Name cannot be empty"
                            return@setOnClickListener
                        }
                        profiles.replaceAll { if (it.id == pid) it.copy(label = name) else it }
                        store.save(profiles)
                        rebuildDrawer()
                        dialog.dismiss()
                    }
            }
    }

    private fun confirmRemove(pid: String) {
        val profile = profiles.find { it.id == pid } ?: return
        MaterialAlertDialogBuilder(this)
            .setTitle("Remove server?")
            .setMessage("${profile.label} (${shortOrigin(profile.origin)})\n\nRemoves the profile only — nothing on the server is touched.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Remove") { _, _ ->
                profiles.removeAll { it.id == pid }
                views.remove(pid)?.let { content.removeView(it); it.destroy() }
                store.save(profiles)
                if (activeId == pid) {
                    activeId = null
                    store.setActiveId(null)
                }
                rebuildDrawer()
                val next = profiles.firstOrNull()?.id
                if (next != null) selectProfile(next, fromUser = false)
                else drawer.openDrawer(GravityCompat.START)
            }
            .show()
    }

    // ---------- back ----------

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        if (drawer.isDrawerOpen(GravityCompat.START)) {
            drawer.closeDrawer(GravityCompat.START)
            return
        }
        val view = activeId?.let { views[it] }
        if (view != null && view.canGoBack()) {
            view.goBack()
            return
        }
        super.onBackPressed()
    }

    companion object {
        const val GROUP_SERVERS = 1
        const val GROUP_FOOTER = 2
        const val ITEM_ADD = 1001

        /** MIME guess for vendored static assets (no server round-trip). */
        fun mimeForPath(p: String): String {
            return when (p.substringAfterLast('.', "").lowercase()) {
                "html" -> "text/html"
                "css" -> "text/css"
                "js", "mjs" -> "text/javascript"
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
                "wasm" -> "application/wasm"
                "pdf" -> "application/pdf"
                "mp3" -> "audio/mpeg"
                "mp4" -> "video/mp4"
                else -> "application/octet-stream"
            }
        }
    }
}
