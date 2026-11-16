package dev.phi.android

import java.net.URI

/**
 * picker.html parseUrls parity (and internal/phic/server_input.go): the
 * add-server form's preprocessing — whitespace-split bulk input, a missing
 * scheme defaults to http://, and an empty port defaults to phi's 7070.
 * Malformed tokens are dropped, not fatal; single-URL origin rules are
 * enforced later by the controller-grade normalizer (normalizeServerUrl).
 */
object ServerInput {
    private val scheme = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://")

    fun parseUrls(raw: String): List<String> =
        raw.split(Regex("[\\r\\n\\s]+"))
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .mapNotNull { token ->
                val withScheme =
                    if (scheme.containsMatchIn(token)) token else "http://$token"
                try {
                    val u = URI(withScheme)
                    val host = u.host ?: return@mapNotNull null
                    val port = if (u.port == -1) 7070 else u.port
                    "${u.scheme}://$host:$port"
                } catch (e: Exception) {
                    null
                }
            }
}
