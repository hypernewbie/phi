package phic

import (
	"context"
	"errors"
	"image/color"
	"math"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
)

// CPU tiers for the Phi brand logo. Thresholds mirror web/header-state.js
// applyBrandCpuTier (>90 critical, >70 high, >30 moderate, else idle):
// the browser page and the TUI classify the same server reading the same
// way. Tiers are static looks, not animations; change is expressed by a
// finite 480ms pulse on tier entry, exactly like the web flourish.
type cpuTier int

const (
	cpuIdle cpuTier = iota
	cpuModerate
	cpuHigh
	cpuCritical
)

func tierForCPU(p float64) cpuTier {
	if math.IsNaN(p) {
		p = 0
	}
	p = min(100, max(0, p))
	switch {
	case p > 90:
		return cpuCritical
	case p > 70:
		return cpuHigh
	case p > 30:
		return cpuModerate
	default:
		return cpuIdle
	}
}

// cpuSystemStats decodes the server's /api/system/cpu reading. Only the
// utilization matters here; the timestamp stays server-side.
type cpuSystemStats struct {
	CPUPercent float64 `json:"cpu"`
}

type msgCPUPoll struct{ origin string }

type msgCPUResult struct {
	origin  string
	percent float64
	err     error
}

type msgCPUPulse struct{}

// cpuFlourishDuration matches the web cpu-tier-pop flourish: one short
// burst on tier entry, then the static tier look holds.
const cpuFlourishDuration = 480 * time.Millisecond

const cpuPollInterval = 2 * time.Second

const cpuPulseStep = 120 * time.Millisecond

// accentHex is the brand accent as hex without '#': the server theme wins,
// otherwise the default. accentColor renders it.
func (m *tuiModel) accentHex() string {
	if d := m.current(); d != nil {
		if hex := phiAccents[d.identity.Theme]; hex != "" {
			return strings.TrimPrefix(hex, "#")
		}
	}
	return "82aaff"
}

// glowAccent mixes the accent toward white: the terminal approximation of
// the web logo glow. amt 0 is the accent itself, 1 is pure white, which is
// the critical tier. Unparseable input falls back to the default accent.
func glowAccent(hex string, amt float64) color.Color {
	clean := strings.TrimPrefix(hex, "#")
	rgb, err := strconv.ParseUint(clean, 16, 32)
	if err != nil || len(clean) != 6 {
		rgb = 0x82aaff
	}
	amt = min(1, max(0, amt))
	mix := func(v uint32) uint8 {
		return uint8(float64(v) + (255-float64(v))*amt + 0.5)
	}
	return color.RGBA{R: mix(uint32(rgb >> 16 & 0xFF)), G: mix(uint32(rgb >> 8 & 0xFF)), B: mix(uint32(rgb & 0xFF)), A: 0xFF}
}

// brandStyles maps a CPU tier to the rail logo and name styles. Roles mirror
// the web tiers: the logo climbs toward white with load (critical is pure
// white), the name stays white until high, then picks up the accent.
func (m *tuiModel) brandStyles(tier cpuTier) (logo, name lg.Style) {
	accent := "#" + m.accentHex()
	white := lg.Color("#ffffff")
	logoFg, nameFg := lg.Color(accent), white
	switch tier {
	case cpuModerate:
		logoFg = glowAccent(accent, 0.35)
	case cpuHigh:
		logoFg, nameFg = glowAccent(accent, 0.65), lg.Color(accent)
	case cpuCritical:
		logoFg, nameFg = white, glowAccent(accent, 0.65)
	}
	if time.Now().Before(m.cpuPulseUntil) && time.Now().UnixMilli()/int64(cpuPulseStep.Milliseconds())%2 == 1 {
		logoFg = white
	}
	return lg.NewStyle().Foreground(logoFg).Bold(true),
		lg.NewStyle().Foreground(nameFg).Bold(true)
}

// cpuPollCmd fetches the active server's CPU reading. Failures decode as a
// zero reading, which the shared apply path leaves idle, exactly like the
// web treating 0 as "no data".
func (m *tuiModel) cpuPollCmd() tea.Cmd {
	origin := m.currentOrigin()
	var api *apiClient
	if s := m.serverForOrigin(origin); s != nil {
		api = s.api
	}
	return func() tea.Msg {
		out := msgCPUResult{origin: origin}
		if api == nil {
			out.err = errors.New("phic: no server for CPU poll")
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		defer cancel()
		var stats cpuSystemStats
		if err := api.getJSON(ctx, "/api/system/cpu", &stats); err != nil {
			out.err = err
			return out
		}
		out.percent = stats.CPUPercent
		return out
	}
}

// cpuPollTick arms one poll turn. Init arms only the tick, never an
// immediate fetch: the first reading lands on steady cadence, after login
// and attach have settled.
func (m *tuiModel) cpuPollTick() tea.Cmd {
	return tea.Tick(cpuPollInterval, func(time.Time) tea.Msg {
		return msgCPUPoll{origin: m.currentOrigin()}
	})
}

func (m *tuiModel) applyCPUResult(msg msgCPUResult) tea.Cmd {
	if m.cpuTiers == nil {
		m.cpuTiers = map[string]cpuTier{}
	}
	percent := msg.percent
	if msg.err != nil {
		percent = 0
	}
	tier := tierForCPU(percent)
	prev, seen := m.cpuTiers[msg.origin]
	m.cpuTiers[msg.origin] = tier
	if !seen || prev == tier {
		return nil
	}
	// Tier change (never the first classification): finite pulse, then the
	// static tier look holds. The pulse chain repaints only for its window.
	m.cpuPulseUntil = time.Now().Add(cpuFlourishDuration)
	return tea.Tick(cpuPulseStep, func(time.Time) tea.Msg { return msgCPUPulse{} })
}
