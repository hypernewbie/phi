package phic

import (
	"github.com/charmbracelet/x/ansi"
	"strings"
	"testing"
)

func TestTabTitleLimitIncludesEllipsisAndKeepsFullTitle(t *testing.T) {
	for _, title := range []string{strings.Repeat("long session ", 20), strings.Repeat("東京", 30), strings.Repeat("e\u0301", 60)} {
		m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
		for _, width := range []int{40, 60, 100, 160, 300} {
			m.width = width
			tab := &paneTab{title: title}
			display := m.tabTitle(tab)
			if ansi.StringWidth(display) > 20 {
				t.Fatalf("%d: title exceeds 20 cells: %q", width, display)
			}
			if !strings.HasSuffix(display, "…") {
				t.Fatalf("%d: long title has no ellipsis: %q", width, display)
			}
			if tab.title != title {
				t.Fatal("presentation truncation changed the saved title")
			}
		}
	}
}

func TestTruncatedTabsHaveMatchingClickTargets(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	origin := m.currentOrigin()
	m.tabs[origin] = nil
	for i := 0; i < 9; i++ {
		m.ensureTab(origin, string(rune('a'+i)), spawnCapture{title: strings.Repeat("really long ", 20) + string(rune('a'+i))})
	}
	for _, width := range []int{60, 100, 160} {
		m.width = width
		m.activeTab[origin] = 6
		plain := ansi.Strip(m.renderTabs())
		// The overflow marker tells us which real indices occupy the strip.
		hit := false
		for x := 0; x < width; x++ {
			if index, ok := m.tabHit(x); ok && index == 6 {
				hit = true
				break
			}
		}
		if !hit {
			t.Fatalf("%d: active shortened tab has no click target: %q", width, plain)
		}
		at := strings.LastIndex(plain, "[x] close")
		if at < 0 || m.tabControlHit(ansi.StringWidth(plain[:at])) != "close" {
			t.Fatalf("%d: shortened tabs lost close-button hit: %q", width, plain)
		}
	}
}
