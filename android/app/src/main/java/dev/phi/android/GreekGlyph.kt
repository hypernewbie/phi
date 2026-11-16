package dev.phi.android

/**
 * Server-selector glyphs — parity port of desktop/electron/src/renderer.ts.
 *
 * A single Greek letter derived from a stable FNV-1a hash of the canonical
 * hostname, so a saved server keeps its glyph across sessions without any
 * manual assignment. Phi (Φ/φ) is excluded: the brand mark belongs to the
 * title row, not to a generated glyph.
 */
object GreekGlyph {
    private val PAIRS = listOf(
        "Α" to "α", "Β" to "β", "Γ" to "γ", "Δ" to "δ", "Ε" to "ε",
        "Ζ" to "ζ", "Η" to "η", "Θ" to "θ", "Ι" to "ι", "Κ" to "κ",
        "Λ" to "λ", "Μ" to "μ", "Ν" to "ν", "Ξ" to "ξ", "Ο" to "ο",
        "Π" to "π", "Ρ" to "ρ", "Σ" to "σ", "Τ" to "τ", "Υ" to "υ",
        "Χ" to "χ", "Ψ" to "ψ", "Ω" to "ω",
    )

    /** Every uppercase and lowercase Greek letter (Φ/φ excluded) plus final sigma. */
    val POOL: List<String> = PAIRS.flatMap { (u, l) -> listOf(u, l) } + "ς"

    /** Case counterpart of a Greek letter for collision disambiguation (ς → Σ). */
    private val CASE: Map<String, String> = buildMap {
        for ((u, l) in PAIRS) {
            put(u, l)
            put(l, u)
        }
        put("ς", "Σ")
    }

    /**
     * canonicalHostname parity: uppercased observed hostname with .local,
     * scheme and explicit port stripped (IPv6 colons kept). Strip order is
     * load-bearing: .local first, then scheme, then port — so
     * "eris.local:7070" keeps its .local (the port tail was in the way),
     * exactly like the desktop rail.
     */
    fun canonicalHostname(raw: String): String {
        var s = raw.trim().uppercase()
        s = s.replace(Regex("\\.LOCAL\\.?$"), "")
        s = s.replace(Regex("^[A-Z][A-Z0-9+.-]*://"), "")
        Regex("^\\[?([^:\\[\\]]+):\\d+$").find(s)?.let { m -> s = m.groupValues[1] }
        return s
    }

    /** FNV-1a 32-bit over the hostname's code units (hostnames are ASCII). */
    fun fnv1a(input: String): Int {
        var hash = -0x7EE3623B // 0x811c9dc5
        for (ch in input) {
            hash = hash xor ch.code
            hash *= 0x01000193
        }
        return hash
    }

    /**
     * A stable Greek letter for a hostname. Collisions resolve to the
     * case-different letter first, then Greek numeral marks (Αʹ, Αʹʹ, …).
     * `used` carries the glyphs already shown in the current render.
     */
    fun forHostname(hostname: String, used: Set<String> = emptySet()): String {
        val h = (fnv1a(canonicalHostname(hostname)).toLong() and 0xFFFFFFFFL)
        val base = POOL[(h % POOL.size).toInt()]
        if (base !in used) return base
        CASE[base]?.let { swapped -> if (swapped !in used) return swapped }
        var marks = 1
        var candidate = base + "ʹ".repeat(marks)
        while (candidate in used && marks < 8) {
            marks += 1
            candidate = base + "ʹ".repeat(marks)
        }
        return candidate
    }
}
