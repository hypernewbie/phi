package phic

import (
	"encoding/json"
	"os"
	"testing"
)

// Run actual Go production logic from the desktop oracle suite. Batched stdin
// avoids spawning a process per case and does not require a TTY or any service.
func TestDesktopParityHelper(t *testing.T) {
	if os.Getenv("PHIC_DESKTOP_PARITY") != "1" {
		return
	}
	var request struct {
		Inputs []string
		UI     []struct{ Name, Hostname, Theme, Health string }
	}
	if err := json.NewDecoder(os.Stdin).Decode(&request); err != nil {
		t.Fatal(err)
	}
	if request.UI != nil {
		type identity struct{ Label, Glyph, Status, Text, Selected, Rail string }
		out := make([]identity, 0, len(request.UI))
		used := map[string]bool{}
		for _, row := range request.UI {
			s := serverState{profile: desktopProfile{Name: row.Name}, identity: serverIdentity{Hostname: row.Hostname, Theme: row.Theme}, health: row.Health}
			glyph := greekGlyphForHostname(s.label(), used)
			used[glyph] = true
			out = append(out, identity{s.label(), glyph, s.statusLabel(), themeText(row.Theme, "TEXT", false), themeText(row.Theme, "TEXT", true), s.railText("TEXT", true)})
		}
		_ = json.NewEncoder(os.Stdout).Encode(out)
		os.Exit(0)
	}
	type result struct {
		URLs    []string
		Origins []string
		Hosts   []string
		Errors  []string
	}
	out := make([]result, 0, len(request.Inputs))
	for _, input := range request.Inputs {
		r := result{URLs: parseServerURLs(input), Origins: []string{}, Hosts: []string{}, Errors: []string{}}
		for _, u := range r.URLs {
			origin, host, err := desktopEndpoint(u)
			if err != nil {
				r.Errors = append(r.Errors, err.Error())
			} else {
				r.Origins = append(r.Origins, origin)
				r.Hosts = append(r.Hosts, host)
			}
		}
		out = append(out, r)
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		t.Fatal(err)
	}
	os.Exit(0)
}
