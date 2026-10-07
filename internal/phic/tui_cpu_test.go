package phic

import (
	"errors"
	"fmt"
	"image/color"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
)

func TestTierForCPU(t *testing.T) {
	cases := []struct {
		cpu  float64
		want cpuTier
	}{
		{0, cpuIdle},
		{30, cpuIdle},
		{30.01, cpuModerate},
		{70, cpuModerate},
		{70.01, cpuHigh},
		{90, cpuHigh},
		{90.01, cpuCritical},
		{100, cpuCritical},
		{-5, cpuIdle},
		{1000, cpuCritical},
		{math.NaN(), cpuIdle},
	}
	for _, tc := range cases {
		if got := tierForCPU(tc.cpu); got != tc.want {
			t.Errorf("tierForCPU(%v) = %v, want %v", tc.cpu, got, tc.want)
		}
	}
}

func rgba8(c color.Color) (r, g, b uint8) {
	r32, g32, b32, _ := c.RGBA()
	return uint8(r32 >> 8), uint8(g32 >> 8), uint8(b32 >> 8)
}

func TestGlowAccent(t *testing.T) {
	// amt 0 is the accent itself.
	r, g, b := rgba8(glowAccent("82aaff", 0))
	if r != 0x82 || g != 0xaa || b != 0xff {
		t.Fatalf("zero glow = #%02x%02x%02x, want #82aaff", r, g, b)
	}
	// amt 1 is pure white: the critical tier.
	r, g, b = rgba8(glowAccent("123456", 1))
	if r != 0xff || g != 0xff || b != 0xff {
		t.Fatalf("full glow = #%02x%02x%02x, want #ffffff", r, g, b)
	}
	// Half glow of black lands on #808080.
	r, g, b = rgba8(glowAccent("000000", 0.5))
	if r != 0x80 || g != 0x80 || b != 0x80 {
		t.Fatalf("half glow of black = #%02x%02x%02x, want #808080", r, g, b)
	}
	// Unparseable input falls back to the default accent (mixed here).
	bad := glowAccent("zzz", 0.5)
	r, g, b = rgba8(bad)
	if r != 0xc1 || g != 0xd5 || b != 0xff {
		t.Fatalf("bad hex = #%02x%02x%02x, want #c1d5ff", r, g, b)
	}
}

func TestApplyCPUResult(t *testing.T) {
	m := deltaTestModel()
	// First classification never pulses (loading shouldn't pop).
	if cmd := m.applyCPUResult(msgCPUResult{origin: "o", percent: 95}); cmd != nil {
		t.Fatal("first classification pulsed")
	}
	if m.cpuTiers["o"] != cpuCritical {
		t.Fatalf("tier = %v, want critical", m.cpuTiers["o"])
	}
	if !m.cpuPulseUntil.IsZero() {
		t.Fatal("first classification set a pulse window")
	}
	// Same tier: silent.
	if cmd := m.applyCPUResult(msgCPUResult{origin: "o", percent: 99}); cmd != nil {
		t.Fatal("unchanged tier pulsed")
	}
	// Tier change: finite pulse armed.
	cmd := m.applyCPUResult(msgCPUResult{origin: "o", percent: 10})
	if cmd == nil {
		t.Fatal("tier change did not pulse")
	}
	if d := time.Until(m.cpuPulseUntil); d < 400*time.Millisecond || d > 600*time.Millisecond {
		t.Fatalf("pulse window = %v, want ~480ms", d)
	}
	// Errors read as zero: idle, never invented load.
	m.applyCPUResult(msgCPUResult{origin: "o", percent: 95, err: errors.New("boom")})
	if m.cpuTiers["o"] != cpuIdle {
		t.Fatalf("error tier = %v, want idle", m.cpuTiers["o"])
	}
}

func TestRailBrandOrder(t *testing.T) {
	m := deltaTestModel()
	m.cpuTiers = map[string]cpuTier{"": cpuHigh}
	m.servers = []*serverState{{profile: desktopProfile{ID: "s", Name: "hammond", Origin: "http://h:1"}}}
	plain := ansi.Strip(m.renderRail())
	logo, name, machine := strings.Index(plain, "Φ"), strings.Index(plain, "Phi"), strings.Index(plain, "HAMMOND")
	if logo < 0 || name < 0 || machine < 0 {
		t.Fatalf("rail missing brand or machine: %q", plain)
	}
	if !(logo < name && name < machine) {
		t.Fatalf("brand order wrong: %q", plain)
	}
}

func TestCPUPollIntegration(t *testing.T) {
	cpu := 95.0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/system/cpu" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"cpu":%v}`, cpu)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	m := newModelWithServer(t, srv)
	defer m.closeAll()
	origin := m.currentOrigin()
	msg := m.cpuPollCmd()()
	res, ok := msg.(msgCPUResult)
	if !ok {
		t.Fatalf("poll returned %T", msg)
	}
	if res.err != nil || res.percent != 95 {
		t.Fatalf("poll result = %+v", res)
	}
	m.Update(res)
	if m.cpuTiers[origin] != cpuCritical {
		t.Fatalf("tier = %v, want critical", m.cpuTiers[origin])
	}
	cpu = 5
	m.Update(m.cpuPollCmd()())
	if m.cpuTiers[origin] != cpuIdle {
		t.Fatalf("tier = %v, want idle", m.cpuTiers[origin])
	}
}
