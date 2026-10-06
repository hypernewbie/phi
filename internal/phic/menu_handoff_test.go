package phic

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
)

func TestServerViewDefaultFocusMatchesDesktopMRU(t *testing.T) {
	c := &client{serverIndex: 1, servers: []*serverState{{profile: desktopProfile{Name: "Alpha"}}, {profile: desktopProfile{Name: "Beta"}}}}
	v := &viewTerminal{input: bytes.NewReader([]byte("\r"))}
	got, err := c.selectionView(t.Context(), v, func() (int, int, error) { return 80, 20, nil }, "Servers", []string{"Alpha", "Beta"}, nil)
	if err != nil || got != 1 {
		t.Fatalf("Enter selected a different server from the active bar: %d %v", got, err)
	}
}

func TestMenuConsumedEnhancedReleaseDoesNotReachRelay(t *testing.T) {
	for _, keys := range []string{"\x1b[13;1u", "\x1b[66;1u\x1b[13;1u"} {
		c := &client{}
		v := &viewTerminal{input: bytes.NewReader([]byte(keys))}
		if _, err := c.selectionView(t.Context(), v, func() (int, int, error) { return 80, 20, nil }, "Sessions", []string{"Alpha", "Beta"}, nil); err != nil {
			t.Fatal(err)
		}
		got, err := c.keys.Feed([]byte("\x1b[66;1:3u\x1b[13;1:3uAPPLICATION"))
		// B's release only belongs to this client if B was actually consumed.
		want := "APPLICATION"
		if keys == "\x1b[13;1u" {
			want = "\x1b[66;1:3uAPPLICATION"
		}
		if err != nil || string(got) != want {
			t.Fatalf("release leaked or unrelated input swallowed: %q %v", got, err)
		}
	}
}

func TestServerBarClipsByCellsAtNarrowWidths(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	c := &client{servers: []*serverState{{profile: desktopProfile{Name: "東京 server with long name"}}, {profile: desktopProfile{Name: "another server"}}}}
	for cols := 7; cols <= 40; cols++ {
		for _, line := range strings.Split(strings.TrimSpace(c.serverBar(cols)), "\r\n") {
			cells := 0
			for _, r := range line {
				cells += cellWidth(r)
			}
			if cells > cols {
				t.Fatalf("server bar wraps untracked at %d columns: %q", cols, line)
			}
		}
	}
	// Desktop rail uses canonical observed identity; profile name remains
	// untouched for the context header and rename form.
	c.servers[0].identity.Hostname = "server-reported hostname.local"
	if c.servers[0].label() != "SERVER-REPORTED HOSTNAME" || c.servers[0].profile.Name != "東京 server with long name" {
		t.Fatal("desktop rail identity/profile name semantics diverged")
	}
	if regexp.MustCompile(`\x1b\[[0-9;]*m`).MatchString(c.serverBar(40)) {
		t.Fatal("NO_COLOR ignored")
	}
}
