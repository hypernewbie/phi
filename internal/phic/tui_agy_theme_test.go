package phic

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/termemu"
)

func TestAgyAnsiColorMapsOnlyAccentSlots(t *testing.T) {
	for _, tc := range []struct {
		index uint32
		want  string
	}{
		{index: 4, want: "5b4ec2"},
		{index: 5, want: "7c6af7"},
		{index: 6, want: "7c6af7"},
		{index: 12, want: "9a8dfa"},
		{index: 13, want: "9a8dfa"},
		{index: 14, want: "9a8dfa"},
	} {
		got := agyAnsiColor(termemu.Color{Kind: termemu.ColorPalette, Value: tc.index}, "purple")
		if got.Kind != termemu.ColorRGB || got.Value != mustRGB(t, tc.want) {
			t.Errorf("palette %d = %#v, want RGB #%s", tc.index, got, tc.want)
		}
	}

	for _, c := range []termemu.Color{
		{Kind: termemu.ColorPalette, Value: 1}, // semantic red stays red
		{Kind: termemu.ColorPalette, Value: 2}, // semantic green stays green
		{Kind: termemu.ColorPalette, Value: 200},
		{Kind: termemu.ColorRGB, Value: 0x123456},
		{Kind: termemu.ColorDefault},
	} {
		if got := agyAnsiColor(c, "purple"); got != c {
			t.Errorf("non-accent color %#v changed to %#v", c, got)
		}
	}
}

func TestAgyAnsiThemeRendersPerServerAndInvalidatesRowsOnThemeChange(t *testing.T) {
	t.Setenv("FORCE_COLOR", "3")
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("NO_COLOR", "")

	m := deltaTestModel()
	origin := "https://agy.example"
	m.data[origin] = &serverData{identity: serverIdentity{Theme: "purple"}}
	tab := &paneTab{key: paneKey{Origin: origin, ID: "agy"}, coder: "agy"}
	frame := termemu.Frame{
		Cols: 1,
		Rows: 1,
		Cells: [][]termemu.Cell{{{
			Text:  "A",
			Width: 1,
			Fg:    termemu.Color{Kind: termemu.ColorPalette, Value: 4},
		}}},
	}

	purple := strings.Join(m.renderFrameLines(tab, frame, 1, 1), "\n")
	if tab.lastAgyTheme != "purple" {
		t.Fatalf("cached Agy theme = %q, want purple", tab.lastAgyTheme)
	}
	m.data[origin].identity.Theme = "blue"
	blue := strings.Join(m.renderFrameLines(tab, frame, 1, 1), "\n")
	if tab.lastAgyTheme != "blue" {
		t.Fatalf("cached Agy theme = %q, want blue after server theme change", tab.lastAgyTheme)
	}
	if purple == blue {
		t.Fatal("Agy ANSI colors did not follow the server accent theme")
	}
	fresh := strings.Join(m.renderFrameLines(&paneTab{key: tab.key, coder: "agy"}, frame, 1, 1), "\n")
	if blue != fresh {
		t.Fatal("theme-updated cached render differs from a cold Agy render")
	}

	// The same palette-indexed bytes on other coders retain the user's terminal palette.
	nonAgy := strings.Join(m.renderFrameLines(&paneTab{key: tab.key, coder: "bash"}, frame, 1, 1), "\n")
	if nonAgy == blue {
		t.Fatal("Agy theme mapping leaked into a non-Agy terminal")
	}
}

func mustRGB(t *testing.T, hex string) uint32 {
	t.Helper()
	var value uint32
	for _, r := range hex {
		value <<= 4
		switch {
		case r >= '0' && r <= '9':
			value |= uint32(r - '0')
		case r >= 'a' && r <= 'f':
			value |= uint32(r-'a') + 10
		default:
			t.Fatalf("invalid hex color %q", hex)
		}
	}
	return value
}

func TestApplyServerLoadedPreservesIdentityOnError(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	origin := m.currentOrigin()

	// 1. Initial load where identity was retrieved, but panes/coders failed with err.
	msg := serverLoadedMsg{
		gen:      m.gen,
		index:    m.active,
		identity: serverIdentity{Theme: "green", Hostname: "hyperion"},
		err:      "connection reset by peer",
	}
	m.applyServerLoaded(msg)

	d := m.data[origin]
	if d == nil {
		t.Fatal("expected serverData to exist")
	}
	if d.identity.Theme != "green" {
		t.Fatalf("expected d.identity.Theme = green, got %q", d.identity.Theme)
	}
	if m.servers[m.active].identity.Theme != "green" {
		t.Fatalf("expected serverState.identity.Theme = green, got %q", m.servers[m.active].identity.Theme)
	}
	if hex := m.accentHex(); hex != strings.TrimPrefix(phiAccents["green"], "#") {
		t.Fatalf("expected accentHex for green, got %q", hex)
	}

	// 2. A subsequent load with needAuth and empty identity should not wipe the known identity.
	emptyAuthMsg := serverLoadedMsg{
		gen:      m.gen,
		index:    m.active,
		needAuth: true,
	}
	m.applyServerLoaded(emptyAuthMsg)
	if d.identity.Theme != "green" {
		t.Fatalf("empty/auth message wiped existing theme: got %q", d.identity.Theme)
	}
}

func TestCPUPollTriggersSelfHealingIdentityWhenThemeEmpty(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	origin := m.currentOrigin()

	// 1. Empty theme: successful CPU poll should emit self-healing command.
	m.data[origin].identity.Theme = ""
	cmd := m.applyCPUResult(msgCPUResult{origin: origin, percent: 10})
	if cmd == nil {
		t.Fatal("expected identityPollCmd when theme is empty")
	}

	// 2. Immediate second poll with empty theme should be rate-limited by cooldown.
	cmdThrottled := m.applyCPUResult(msgCPUResult{origin: origin, percent: 10})
	if cmdThrottled != nil {
		t.Fatal("expected no identityPollCmd within cooldown window")
	}

	// 3. Advancing past cooldown allows polling again.
	m.identityPolls[origin] = time.Now().Add(-identityPollCooldown - time.Second)
	cmdAfterCooldown := m.applyCPUResult(msgCPUResult{origin: origin, percent: 10})
	if cmdAfterCooldown == nil {
		t.Fatal("expected identityPollCmd after cooldown elapsed")
	}

	// 4. Populated theme: successful CPU poll should not emit identity command.
	m.data[origin].identity.Theme = "emerald"
	m.identityPolls = nil
	cmdPopulated := m.applyCPUResult(msgCPUResult{origin: origin, percent: 10})
	if cmdPopulated != nil {
		t.Fatal("expected no identityPollCmd when theme is already populated")
	}

	// 5. Error CPU poll: should not emit identity command.
	m.data[origin].identity.Theme = ""
	cmdErr := m.applyCPUResult(msgCPUResult{origin: origin, err: context.DeadlineExceeded})
	if cmdErr != nil {
		t.Fatal("expected no identityPollCmd when CPU poll failed")
	}
}

func TestIdentityPollAndApplyLifecycle(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/config" {
			_ = json.NewEncoder(w).Encode(serverIdentity{
				Theme:    "mint",
				Hostname: "hyperion",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	m, _, _ := closeControlsModel(t)
	api, err := newAPIClient(ts.URL)
	if err != nil {
		t.Fatalf("newAPIClient failed: %v", err)
	}

	m.servers = append(m.servers, &serverState{
		profile: desktopProfile{ID: "hyperion", Origin: ts.URL},
		api:     api,
	})
	m.active = len(m.servers) - 1
	m.data[ts.URL] = &serverData{}

	// Run identityPollCmd end-to-end
	cmd := m.identityPollCmd(ts.URL)
	if cmd == nil {
		t.Fatal("expected non-nil identityPollCmd")
	}
	resMsg := cmd()
	idRes, ok := resMsg.(msgIdentityResult)
	if !ok {
		t.Fatalf("expected msgIdentityResult, got %T: %#v", resMsg, resMsg)
	}
	if idRes.origin != ts.URL || idRes.identity.Theme != "mint" || idRes.identity.Hostname != "hyperion" {
		t.Fatalf("unexpected identity result: %+v", idRes)
	}

	// Apply identity result
	m.applyIdentityResult(idRes)
	d := m.data[ts.URL]
	if d.identity.Theme != "mint" || d.identity.Hostname != "hyperion" {
		t.Fatalf("applyIdentityResult failed to update serverData: %+v", d.identity)
	}
	s := m.servers[m.active]
	if s.identity.Theme != "mint" || s.identity.Hostname != "hyperion" {
		t.Fatalf("applyIdentityResult failed to update serverState: %+v", s.identity)
	}
	if hex := m.accentHex(); hex != strings.TrimPrefix(phiAccents["mint"], "#") {
		t.Fatalf("expected accentHex = mint (%q), got %q", strings.TrimPrefix(phiAccents["mint"], "#"), hex)
	}

	// Empty identity result should be a no-op and never wipe known identity
	m.applyIdentityResult(msgIdentityResult{origin: ts.URL, identity: serverIdentity{}})
	if d.identity.Theme != "mint" {
		t.Fatalf("empty identity wiped theme: got %q", d.identity.Theme)
	}
}
