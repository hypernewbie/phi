package dev.phi.android

import org.junit.Assert.assertEquals
import org.junit.Test

/** picker.html parseUrls parity, locked by the same cases the desktop
 *  picker exercises: scheme default, port autofill, bulk split, junk drop. */
class ServerInputTest {
    @Test fun bareHostDefaultsToHttp7070() {
        assertEquals(listOf("http://pluto:7070"), ServerInput.parseUrls("pluto"))
    }

    @Test fun explicitSchemeAndPortKept() {
        assertEquals(
            listOf("https://example.com:8443"),
            ServerInput.parseUrls("https://example.com:8443"),
        )
    }

    @Test fun httpsDefaultsTo7070Too() {
        assertEquals(
            listOf("https://example.com:7070"),
            ServerInput.parseUrls("https://example.com"),
        )
    }

    @Test fun bulkInputSplitsOnWhitespace() {
        assertEquals(
            listOf("http://a.example:7070", "http://b.example:7070"),
            ServerInput.parseUrls("a.example b.example"),
        )
        assertEquals(
            listOf("http://a.example:7070", "http://b.example:7070"),
            ServerInput.parseUrls("a.example\nb.example"),
        )
    }

    @Test fun malformedTokensAreDroppedNotFatal() {
        assertEquals(
            listOf("http://ok.example:7070"),
            ServerInput.parseUrls("http://[broken ok.example"),
        )
    }
}
