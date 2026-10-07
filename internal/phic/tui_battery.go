package phic

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
)

const batteryPollInterval = time.Minute

type msgBatteryPoll struct{}
type msgBatteryResult struct {
	percent int
	known   bool
}

func batterySupported() bool { return runtime.GOOS == "linux" || runtime.GOOS == "darwin" }

func batteryPollTick(delay time.Duration) tea.Cmd {
	if !batterySupported() {
		return nil
	}
	return tea.Tick(delay, func(time.Time) tea.Msg { return msgBatteryPoll{} })
}

func batteryPollCmd() tea.Cmd {
	return func() tea.Msg {
		percent, known := readLocalBattery()
		return msgBatteryResult{percent: percent, known: known}
	}
}

func readLocalBattery() (int, bool) {
	switch runtime.GOOS {
	case "linux":
		return readLinuxBattery("/sys/class/power_supply")
	case "darwin":
		// One system utility invocation per minute; no shell or daemon.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		output, err := exec.CommandContext(ctx, "/usr/bin/pmset", "-g", "batt").Output()
		if err != nil {
			return 0, false
		}
		return parseMacBattery(string(output))
	default:
		return 0, false
	}
}

var macBatteryPercent = regexp.MustCompile(`\b([0-9]{1,3})%;`)

func parseMacBattery(output string) (int, bool) {
	for _, line := range strings.Split(output, "\n") {
		if !strings.Contains(line, "InternalBattery") || strings.Contains(line, "present: false") {
			continue
		}
		match := macBatteryPercent.FindStringSubmatch(line)
		if len(match) != 2 {
			continue
		}
		percent, err := strconv.Atoi(match[1])
		if err == nil && percent >= 0 && percent <= 100 {
			return percent, true
		}
	}
	return 0, false
}

func readLinuxBattery(root string) (int, bool) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, false
	}
	read := func(dir, name string) string {
		b, _ := os.ReadFile(filepath.Join(root, dir, name))
		return strings.TrimSpace(string(b))
	}
	sum, count := 0, 0
	for _, entry := range entries {
		name := entry.Name()
		// sysfs entries can be symlinks. Exclude AC supplies and peripheral
		// batteries (mouse, keyboard, etc.), not just names other than BAT0.
		if read(name, "type") != "Battery" || read(name, "scope") == "Device" || read(name, "present") == "0" {
			continue
		}
		percent, err := strconv.Atoi(read(name, "capacity"))
		if err != nil || percent < 0 || percent > 100 {
			continue
		}
		sum += percent
		count++
	}
	if count == 0 {
		return 0, false
	}
	return (sum + count/2) / count, true
}

func (m *tuiModel) batteryLabel() string {
	if !m.batteryKnown {
		return ""
	}
	return lg.NewStyle().Foreground(tuiMuted).Render(fmt.Sprintf(" %d%%", m.batteryPercent))
}
