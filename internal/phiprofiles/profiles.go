// Package phiprofiles reads the desktop's shared profile document.
//
// One parser, used by the desktop loader path, phic, and phi-cmd. The
// document is Electron's userData profiles.json: a JSON object whose
// "profiles" array holds rows with id/name/origin/lastUsed. Everything
// else in the object belongs to the desktop and is preserved verbatim by
// writers; this package only defines the read shape plus the row access
// writers need.
package phiprofiles

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Profile is one non-secret rail row. IDs, names, origins and rail order
// are preserved, including legacy aliases.
type Profile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Origin   string `json:"origin"`
	LastUsed string `json:"lastUsed,omitempty"`
}

// Document is a parsed profile document. fields holds the whole object
// (including unknown desktop settings) so a writer can re-emit it; rows
// holds the deduplicated, valid profile rows in document order.
type Document struct {
	fields map[string]json.RawMessage
	rows   []map[string]json.RawMessage
}

// Fields exposes the document's full object for writers that must
// preserve desktop settings. The returned map is the document itself.
func (d *Document) Fields() map[string]json.RawMessage { return d.fields }

// Rows exposes the raw profile rows for writers. Order is document order.
func (d *Document) Rows() []map[string]json.RawMessage { return d.rows }

// Row returns the live row map for one id, so a writer can set fields on
// it directly. Maps are reference types: mutating the returned row mutates
// the document.
func (d *Document) Row(id string) (map[string]json.RawMessage, bool) {
	for _, row := range d.rows {
		if jsonString(row["id"]) == id {
			return row, true
		}
	}
	return nil, false
}

// AppendRow adds one raw row at the end of the rail.
func (d *Document) AppendRow(row map[string]json.RawMessage) {
	d.rows = append(d.rows, row)
}

// RemoveRowByID deletes one row. It reports whether a row was removed.
func (d *Document) RemoveRowByID(id string) bool {
	for i, row := range d.rows {
		if jsonString(row["id"]) == id {
			d.rows = append(d.rows[:i], d.rows[i+1:]...)
			return true
		}
	}
	return false
}

// MoveRowBefore moves the row with id immediately before the row with
// beforeID, or to the end when beforeID is empty. It reports whether the
// id row exists and whether the beforeID row exists; a caller that passed
// a beforeID maps a missing anchor to its own error. A missing id row or a
// no-op move leaves the document unchanged.
func (d *Document) MoveRowBefore(id, beforeID string) (found, beforeFound bool) {
	from, to := -1, len(d.rows)
	for i, row := range d.rows {
		if jsonString(row["id"]) == id {
			from = i
		}
		if beforeID != "" && jsonString(row["id"]) == beforeID {
			to = i
		}
	}
	if from < 0 {
		return false, beforeID == "" || to != len(d.rows)
	}
	if beforeID != "" && to == len(d.rows) {
		return true, false
	}
	if from == to || from+1 == to {
		return true, true
	}
	row := d.rows[from]
	d.rows = append(d.rows[:from], d.rows[from+1:]...)
	if from < to {
		to--
	}
	d.rows = append(d.rows, nil)
	copy(d.rows[to+1:], d.rows[to:])
	d.rows[to] = row
	return true, true
}

// Profiles returns the parsed rows, in document order. A missing name
// falls back to the origin, matching every reader of this document.
func (d *Document) Profiles() []Profile {
	out := make([]Profile, 0, len(d.rows))
	for _, row := range d.rows {
		p := Profile{
			ID:       jsonString(row["id"]),
			Name:     jsonString(row["name"]),
			Origin:   jsonString(row["origin"]),
			LastUsed: jsonString(row["lastUsed"]),
		}
		if p.Name == "" {
			p.Name = p.Origin
		}
		out = append(out, p)
	}
	return out
}

func jsonString(value json.RawMessage) string {
	var s string
	_ = json.Unmarshal(value, &s)
	return s
}

// Parse decodes a desktop profile document. Rows without both id and
// origin, and duplicate ids, are skipped — the same tolerance the desktop
// loader applies. A document without a profiles array is an error, not an
// empty list, so a corrupt file is never mistaken for an empty rail.
func Parse(data []byte) (*Document, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, fmt.Errorf("invalid desktop profile document")
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(fields["profiles"], &entries); err != nil || entries == nil {
		return nil, fmt.Errorf("invalid desktop profile list")
	}
	d := &Document{fields: fields, rows: make([]map[string]json.RawMessage, 0, len(entries))}
	seen := map[string]bool{}
	for _, entry := range entries {
		var row map[string]json.RawMessage
		if json.Unmarshal(entry, &row) != nil {
			continue
		}
		id, origin := jsonString(row["id"]), jsonString(row["origin"])
		if id == "" || origin == "" || seen[id] {
			continue
		}
		seen[id] = true
		d.rows = append(d.rows, row)
	}
	return d, nil
}

// Empty is the document a first run starts from: an empty rail and the
// desktop's default settings object.
func Empty() *Document {
	d, _ := Parse([]byte(`{"profiles":[],"closeToTray":true,"syncAlerts":true,"lowMemoryMode":false,"petEnabled":false,"petZoomPercent":100,"contentZoomPercent":100,"petIdleDwellSeconds":10}`))
	return d
}

// Paths returns the candidate profile documents in precedence order: the
// current phi-client location first, then Electron's legacy locations.
// A reader tries each; a writer targets the first existing one or the
// head of the list.
func Paths(configDir string) []string {
	return []string{
		filepath.Join(configDir, "phi-client", "profiles.json"),
		filepath.Join(configDir, "phi-desktop-electron", "profiles.json"),
		filepath.Join(configDir, "Phi", "profiles.json"),
	}
}

// DefaultPath resolves the document path the same way phic does: an
// explicit override, else the first existing candidate (or its .bak),
// else the head of the list in the user config dir.
func DefaultPath(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	paths := Paths(dir)
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		} else if !os.IsNotExist(err) {
			return "", err
		}
		if _, err := os.Stat(p + ".bak"); err == nil {
			return p, nil
		}
	}
	return paths[0], nil
}
