package dev.phi.android

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** One saved Phi server profile: the rail-relevant slice (mirrors controller.ts). */
data class ServerProfile(val id: String, val label: String, val origin: String)

/**
 * Normalizes a raw server URL the way the desktop controller does:
 * http/https only, root path only, no userinfo/query/fragment.
 * Missing scheme defaults to http (phone-friendly).
 * Returns the canonical origin, or null with a human-readable reason.
 */
fun normalizeServerUrl(raw: String): Result<String> {
    var input = raw.trim()
    if (input.isEmpty()) return Result.failure(IllegalArgumentException("Enter a server URL"))
    if (!input.contains("://")) input = "http://$input"
    val uri = try {
        android.net.Uri.parse(input)
    } catch (e: Exception) {
        return Result.failure(IllegalArgumentException("Not a valid URL"))
    }
    val scheme = (uri.scheme ?: "").lowercase()
    if (scheme != "http" && scheme != "https") {
        return Result.failure(IllegalArgumentException("URL must start with http:// or https://"))
    }
    val host = (uri.host ?: "").lowercase()
    if (host.isEmpty()) return Result.failure(IllegalArgumentException("URL has no hostname"))
    if (uri.userInfo != null) {
        return Result.failure(IllegalArgumentException("URL must not contain userinfo"))
    }
    val path = uri.path ?: ""
    if (path.isNotEmpty() && path != "/") {
        return Result.failure(IllegalArgumentException("Use the root URL (no path)"))
    }
    if (uri.query != null || uri.fragment != null) {
        return Result.failure(IllegalArgumentException("URL must not contain ? or # parts"))
    }
    val port = if (uri.port != -1) ":${uri.port}" else ""
    return Result.success("$scheme://$host$port")
}

/** Default label for a freshly added server: host, plus non-default port. */
fun defaultLabelFor(origin: String): String {
    val uri = android.net.Uri.parse(origin)
    val host = uri.host ?: origin
    val port = if (uri.port != -1) ":${uri.port}" else ""
    return "$host$port"
}

/** Display name shown in the drawer: cached server-reported hostname, else pretty host. */
fun prettyHost(origin: String): String {
    val host = android.net.Uri.parse(origin).host ?: return origin
    val first = host.split(".").firstOrNull().orEmpty()
    return first.uppercase().ifEmpty { host.uppercase() }
}

/** Deterministic badge slot per origin; stable across restarts, no storage.
 * Letters follow drawer order (caller passes the index); colors hash the URL. */
fun badgeSlot(origin: String, index: Int, paletteSize: Int, letterCount: Int): Pair<Int, Int> {
    val color = (origin.hashCode() and 0x7fffffff) % paletteSize
    return Pair(color, index % letterCount)
}

/** SharedPreferences-backed profile list. Synchronous; lists are tiny.
 * Also caches per-origin display names (server-reported hostnames) and the
 * app-wide text zoom. */
class ServerStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("phi_servers", Context.MODE_PRIVATE)

    fun load(): MutableList<ServerProfile> {
        val out = mutableListOf<ServerProfile>()
        val raw = prefs.getString("profiles", null) ?: return out
        val arr = try {
            JSONArray(raw)
        } catch (e: Exception) {
            return out
        }
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id").ifEmpty { continue }
            val label = o.optString("label", "")
            val origin = o.optString("origin").ifEmpty { continue }
            out.add(ServerProfile(id, label.ifEmpty { defaultLabelFor(origin) }, origin))
        }
        return out
    }

    fun save(profiles: List<ServerProfile>) {
        val arr = JSONArray()
        for (p in profiles) {
            arr.put(JSONObject().put("id", p.id).put("label", p.label).put("origin", p.origin))
        }
        prefs.edit().putString("profiles", arr.toString()).apply()
    }

    fun activeId(): String? = prefs.getString("active", null)

    fun setActiveId(id: String?) {
        prefs.edit().putString("active", id).apply()
    }

    fun newId(): String = UUID.randomUUID().toString()

    fun displayNameFor(origin: String): String =
        prefs.getString("name:$origin", null) ?: prettyHost(origin)

    fun setDisplayName(origin: String, name: String) {
        prefs.edit().putString("name:$origin", name).apply()
    }

    fun zoom(): Int = prefs.getInt("zoom", 100).coerceIn(50, 200)

    fun setZoom(z: Int) {
        prefs.edit().putInt("zoom", z.coerceIn(50, 200)).apply()
    }
}
