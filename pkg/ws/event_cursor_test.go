package ws

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestEventCursorFormatIsStable pins the cursor shape. Clients reject a
// cursor they cannot parse, so the version prefix is a wire contract, not
// an internal detail.
func TestEventCursorFormatIsStable(t *testing.T) {
	cursor := EncodeEventCursor(7, 42, 3)
	if cursor != "v1.7.42.3" {
		t.Fatalf("unexpected cursor encoding: %q", cursor)
	}
	epoch, pos, ordinal, err := ParseEventCursor(cursor)
	if err != nil || epoch != 7 || pos != 42 || ordinal != 3 {
		t.Fatalf("cursor did not round trip: %v %d %d %d", err, epoch, pos, ordinal)
	}
	for _, bad := range []string{"", "1.7.42.3", "v2.7.42.3", "v1.7.42", "v1.7.42.3.1", "v1.x.42.3"} {
		if _, _, _, err := ParseEventCursor(bad); err == nil {
			t.Fatalf("malformed cursor accepted: %q", bad)
		}
	}
}

// TestEventCursorFormatMatchesClients reads the two clients that fence
// replay pages. The web page matches the cursor with a regular
// expression, and the native client parses it with its own prefix
// check. A server that encodes a different shape leaves both clients
// holding a malformed frame.
func TestEventCursorFormatMatchesClients(t *testing.T) {
	root := filepath.Join("..", "..")
	web, err := os.ReadFile(filepath.Join(root, "web-src", "ws.ts"))
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`/\^v([0-9]+)\\\.\\d\+\\\.\\d\+\\\.\\d\+\$/`).FindSubmatch(web)
	if match == nil {
		t.Fatal("web-src/ws.ts: the event cursor pattern is gone")
	}
	if "v"+string(match[1]) != eventCursorVersion {
		t.Fatalf("web page expects cursor version %q, the server encodes %q", "v"+string(match[1]), eventCursorVersion)
	}
	client, err := os.ReadFile(filepath.Join(root, "internal", "phic", "replay.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(client), `parts[0] != "`+eventCursorVersion+`"`) {
		t.Fatalf("the native client does not parse cursor version %q", eventCursorVersion)
	}
}
