package coders

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// LoadFromDir reads ~/.phi/backends/*.json (or the supplied directory
// in tests), parses each file as a CoderPatch, applies it onto the
// built-in profile with the matching ID (if any), and inserts the
// result into the Manager. Patches for unknown IDs are added as new
// coders. Patches for reserved IDs (review, kanban, pi-rpc) are
// rejected.
//
// Per-file failures (parse error, validation error, reserved ID) are
// logged via the supplied warn function and the file is skipped. The
// resolver never aborts startup on a single malformed file.
//
// Files are processed in lexicographic order for deterministic
// patch application (R3). Same fixtures → same merged registry.
func (m *Manager) LoadFromDir(dir string, warn func(string)) error {
	if warn == nil {
		warn = func(string) {}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // no custom-backends dir → no-op
		}
		return fmt.Errorf("read backends dir %q: %w", dir, err)
	}

	files := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		files = append(files, e.Name())
	}
	sort.Strings(files)

	for _, name := range files {
		path := filepath.Join(dir, name)
		if err := m.loadOne(path, warn); err != nil {
			// loadOne already warned; continue.
			continue
		}
	}
	return nil
}

// loadOne reads, decodes, validates, and inserts one backend file.
// All error paths call warn; the returned error is the same warn-able
// error so callers can decide policy.
func (m *Manager) loadOne(path string, warn func(string)) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		warn(fmt.Sprintf("[backends] read %s: %v", path, err))
		return err
	}

	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	var patch CoderPatch
	if err := dec.Decode(&patch); err != nil {
		warn(fmt.Sprintf("[backends] parse %s: %v", path, err))
		return err
	}

	// Logo and attachment_syntax validation are file-level concerns;
	// the public descriptor doesn't carry attachment_syntax yet but
	// a custom backend could declare one in the future. Validate
	// here so the consumer side never sees an unsafe value.
	if patch.Logo != nil {
		if v := ValidateLogo(*patch.Logo); v != *patch.Logo {
			warn(fmt.Sprintf("[backends] %s: invalid logo %q (must be vendor/<path>, emoji:<g>, or text:<t>)", path, *patch.Logo))
			return fmt.Errorf("invalid logo")
		}
	}

	// Determine the base: an existing built-in with the same ID, or
	// a fresh zero Coder if the patch declares a new ID.
	var base Coder
	if patch.ID != nil {
		if existing, ok := m.Get(*patch.ID); ok {
			base = existing
		} else if !ReservedIDs[*patch.ID] {
			base = Coder{
				ID:           *patch.ID,
				SidebarVisible: true,
				InputMode:    "staged",
			}
		} else {
			warn(fmt.Sprintf("[backends] %s: reserved id %q rejected", path, *patch.ID))
			return ErrReservedID
		}
	}

	resolved, err := patch.Apply(base)
	if err != nil {
		warn(fmt.Sprintf("[backends] %s: %v", path, err))
		return err
	}

	if !m.Add(resolved) {
		warn(fmt.Sprintf("[backends] %s: id %q rejected (empty or reserved)", path, resolved.ID))
		return ErrReservedID
	}
	return nil
}
