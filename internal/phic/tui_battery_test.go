package phic

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestParseMacBattery(t *testing.T) {
	for _, tc := range []struct {
		input   string
		percent int
		known   bool
	}{
		{"Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t73%; discharging; 4:20 remaining present: true", 73, true},
		{" -InternalBattery-0 (id=123)\t100%; charged; 0:00 remaining present: true", 100, true},
		{" -InternalBattery-0 (id=123)\t0%; discharging; present: true", 0, true},
		{"Now drawing from 'AC Power'", 0, false},
		{" -InternalBattery-0\t101%; charged; present: true", 0, false},
		{" -InternalBattery-0\t90%; present: false", 0, false},
		{" -UPS\t80%; discharging; present: true", 0, false},
		{" -InternalBattery-0\tunknown%;", 0, false},
	} {
		percent, known := parseMacBattery(tc.input)
		if percent != tc.percent || known != tc.known {
			t.Fatalf("%q: (%d,%v), want (%d,%v)", tc.input, percent, known, tc.percent, tc.known)
		}
	}
}

func TestReadLinuxBattery(t *testing.T) {
	root := t.TempDir()
	add := func(name string, files map[string]string) {
		t.Helper()
		dir := filepath.Join(root, name)
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		for key, value := range files {
			if err := os.WriteFile(filepath.Join(dir, key), []byte(value), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, known := readLinuxBattery(root); known {
		t.Fatal("empty directory reports battery")
	}
	add("AC", map[string]string{"type": "Mains\n", "capacity": "100"})
	add("mouse", map[string]string{"type": "Battery", "scope": "Device", "capacity": "99"})
	add("absent", map[string]string{"type": "Battery", "present": "0", "capacity": "10"})
	add("broken", map[string]string{"type": "Battery", "capacity": "101"})
	if _, known := readLinuxBattery(root); known {
		t.Fatal("peripherals/invalid entries report battery")
	}
	// Real sysfs uses symlinks, not ordinary directories.
	actual := t.TempDir()
	for key, value := range map[string]string{"type": "Battery\n", "scope": "System\n", "present": "1\n", "capacity": "42\n"} {
		if err := os.WriteFile(filepath.Join(actual, key), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(actual, filepath.Join(root, "BAT0")); err != nil {
		t.Skip(err)
	}
	if percent, known := readLinuxBattery(root); !known || percent != 42 {
		t.Fatalf("battery: %d %v", percent, known)
	}
	add("BAT1", map[string]string{"type": "Battery", "capacity": "64"})
	if percent, known := readLinuxBattery(root); !known || percent != 53 {
		t.Fatalf("two batteries: %d %v", percent, known)
	}
	if _, known := readLinuxBattery(filepath.Join(root, "missing")); known {
		t.Fatal("missing root reports battery")
	}
}

func TestBatteryPercentageInRail(t *testing.T) {
	m := deltaTestModel()
	m.width = 160
	if m.batteryLabel() != "" {
		t.Fatal("unknown battery displayed")
	}
	m.Update(msgBatteryResult{percent: 73, known: true})
	rail := ansi.Strip(m.renderRail())
	if !strings.HasSuffix(strings.TrimSpace(rail), "73%") {
		t.Fatalf("percentage not top right: %q", rail)
	}
	if strings.Contains(rail, "Battery") {
		t.Fatal("battery should only show percentage")
	}
	m.Update(msgBatteryResult{percent: 0, known: true})
	if ansi.Strip(m.batteryLabel()) != " 0%" {
		t.Fatal("empty battery hidden")
	}
	m.Update(msgBatteryResult{})
	if m.batteryLabel() != "" {
		t.Fatal("stale reading remains after battery unavailable")
	}
}
