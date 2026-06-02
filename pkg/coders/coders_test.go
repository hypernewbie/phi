package coders

import (
	"testing"
)

func TestRegistryPresets(t *testing.T) {
	// Let's ensure the registry is not empty and has some entries.
	if len(Registry) == 0 {
		t.Fatal("Expected coder registry to have configured presets, but it is empty")
	}

	// We must validate that each entry is properly configured.
	for id, coder := range Registry {
		if coder.ID != id {
			t.Errorf("Coder ID mismatch for key %q: got %q", id, coder.ID)
		}
		if coder.Name == "" {
			t.Errorf("Coder %s has an empty name", id)
		}
		if coder.Command == "" {
			t.Errorf("Coder %s has an empty command", id)
		}

		// Ensure all presets are correctly formatted.
		for _, preset := range coder.Presets {
			if preset.Name == "" {
				t.Errorf("Coder %s has a preset with an empty name", id)
			}
			if preset.Value == "" {
				t.Errorf("Coder %s has a preset with an empty value", id)
			}
		}
	}
}
