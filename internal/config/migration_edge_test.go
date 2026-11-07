package config

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func newTestIsolatedStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	return NewStore(Paths{Primary: path}, nil), path
}

func TestMigrationNewMarker(t *testing.T) {
	t.Run("valid_states", func(t *testing.T) {
		validStates := []string{"pending", "complete"}
		for _, state := range validStates {
			marker, err := NewMigrationMarker(state)
			if err != nil {
				t.Fatalf("NewMigrationMarker(%q) returned unexpected error: %v", state, err)
			}
			if marker == nil {
				t.Fatalf("NewMigrationMarker(%q) returned nil marker", state)
			}
			if marker.State != state {
				t.Fatalf("expected state %q, got %q", state, marker.State)
			}
			if marker.ID == "" {
				t.Fatal("expected non-empty marker ID")
			}

			idBytes, err := MigrationMarkerID(marker)
			if err != nil {
				t.Fatalf("MigrationMarkerID failed on newly created marker: %v", err)
			}
			decoded, err := base64.RawURLEncoding.DecodeString(marker.ID)
			if err != nil {
				t.Fatalf("failed to decode marker ID %q: %v", marker.ID, err)
			}
			if len(decoded) != 16 {
				t.Fatalf("expected 16 decoded bytes for marker ID, got %d", len(decoded))
			}
			if !reflect.DeepEqual(idBytes[:], decoded) {
				t.Fatalf("MigrationMarkerID byte mismatch: got %v, want %v", idBytes[:], decoded)
			}
		}
	})

	t.Run("unique_128_bit_ids", func(t *testing.T) {
		const iterations = 100
		seenIDs := make(map[string]struct{}, iterations)

		for i := 0; i < iterations; i++ {
			marker, err := NewMigrationMarker("pending")
			if err != nil {
				t.Fatalf("iteration %d: unexpected error: %v", i, err)
			}
			if _, exists := seenIDs[marker.ID]; exists {
				t.Fatalf("duplicate marker ID generated: %q", marker.ID)
			}
			seenIDs[marker.ID] = struct{}{}

			decoded, err := base64.RawURLEncoding.DecodeString(marker.ID)
			if err != nil {
				t.Fatalf("iteration %d: failed to decode ID %q: %v", i, marker.ID, err)
			}
			if len(decoded) != 16 {
				t.Fatalf("iteration %d: expected 16 bytes (128 bits), got %d", i, len(decoded))
			}
		}
	})

	t.Run("rejection_of_invalid_states", func(t *testing.T) {
		invalidStates := []string{
			"",
			"invalid",
			"PENDING",
			"COMPLETE",
			"in_progress",
			"done",
			"completed",
			"unknown",
			"pending ",
			" complete",
		}

		for _, state := range invalidStates {
			marker, err := NewMigrationMarker(state)
			if err == nil {
				t.Fatalf("NewMigrationMarker(%q) succeeded, expected error", state)
			}
			if marker != nil {
				t.Fatalf("NewMigrationMarker(%q) returned non-nil marker on failure: %+v", state, marker)
			}
		}
	})
}

func TestMigrationMarkerID(t *testing.T) {
	t.Run("valid_16_byte_base64url_decoding", func(t *testing.T) {
		raw := [16]byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10}
		encoded := base64.RawURLEncoding.EncodeToString(raw[:])

		for _, state := range []string{"pending", "complete"} {
			marker := &MigrationMarker{
				State: state,
				ID:    encoded,
			}
			got, err := MigrationMarkerID(marker)
			if err != nil {
				t.Fatalf("unexpected error validating marker for state %q: %v", state, err)
			}
			if got != raw {
				t.Fatalf("decoded ID mismatch: got %x, want %x", got, raw)
			}
		}
	})

	t.Run("rejection_of_nil_marker", func(t *testing.T) {
		var zero [16]byte
		got, err := MigrationMarkerID(nil)
		if err == nil {
			t.Fatal("MigrationMarkerID(nil) succeeded, expected error")
		}
		if got != zero {
			t.Fatalf("expected zeroed array on error, got %x", got)
		}
	})

	t.Run("rejection_of_empty_state_and_id", func(t *testing.T) {
		validID := base64.RawURLEncoding.EncodeToString(make([]byte, 16))

		cases := []*MigrationMarker{
			{State: "", ID: validID},
			{State: "pending", ID: ""},
			{State: "complete", ID: ""},
			{State: "", ID: ""},
		}

		for _, marker := range cases {
			if _, err := MigrationMarkerID(marker); err == nil {
				t.Fatalf("MigrationMarkerID(%+v) succeeded, expected error", marker)
			}
		}
	})

	t.Run("rejection_of_wrong_decoded_byte_length", func(t *testing.T) {
		invalidLengths := []int{0, 1, 7, 15, 17, 24, 32}

		for _, length := range invalidLengths {
			encoded := base64.RawURLEncoding.EncodeToString(make([]byte, length))
			marker := &MigrationMarker{
				State: "pending",
				ID:    encoded,
			}
			if _, err := MigrationMarkerID(marker); err == nil {
				t.Fatalf("expected length %d to fail, but MigrationMarkerID succeeded", length)
			}
		}
	})

	t.Run("rejection_of_invalid_base64url_characters", func(t *testing.T) {
		validBytes := make([]byte, 16)
		// Standard encoding with padding '=' character.
		stdWithPadding := base64.StdEncoding.EncodeToString(validBytes)

		// IDs containing non-base64url characters.
		invalidCharacters := []string{
			stdWithPadding,
			"!!!!!!!!!!!!!!!!!!!!!!",
			"abcdefghijklmnopqrstuv+",
			"abcdefghijklmnopqrstuv/",
			"with whitespace inside",
			"with\nnewline\nin\nid",
			"short#invalid!char",
		}

		for _, badID := range invalidCharacters {
			marker := &MigrationMarker{
				State: "pending",
				ID:    badID,
			}
			if _, err := MigrationMarkerID(marker); err == nil {
				t.Fatalf("MigrationMarkerID accepted invalid characters ID %q", badID)
			}
		}
	})

	t.Run("rejection_of_non_canonical_base64url_encoding", func(t *testing.T) {
		// A 16-byte raw payload encodes to 22 base64 characters.
		// The 22nd character holds 2 data bits and 4 padding bits which must be zero.
		// Toggling one of the unused padding bits tests canonical encoding enforcement.
		canonical := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
		if len(canonical) != 22 {
			t.Fatalf("expected 22 encoded characters, got %d", len(canonical))
		}
		// The 22nd character of 16 zero bytes is 'A' (bits 000000).
		// Replacing 'A' with 'B' (bits 000001) leaves the data bits identical but sets an unused bit.
		nonCanonical := canonical[:21] + "B"

		marker := &MigrationMarker{
			State: "pending",
			ID:    nonCanonical,
		}
		if _, err := MigrationMarkerID(marker); err == nil {
			t.Fatal("MigrationMarkerID accepted non-canonical base64url marker ID")
		}
	})
}

func TestMigrationSameMarker(t *testing.T) {
	markerA1, err := NewMigrationMarker("pending")
	if err != nil {
		t.Fatal(err)
	}
	markerA2 := &MigrationMarker{
		State: markerA1.State,
		ID:    markerA1.ID,
	}
	markerB, err := NewMigrationMarker("pending")
	if err != nil {
		t.Fatal(err)
	}
	completeA := &MigrationMarker{
		State: "complete",
		ID:    markerA1.ID,
	}
	completeB, err := NewMigrationMarker("complete")
	if err != nil {
		t.Fatal(err)
	}

	t.Run("nil_equality", func(t *testing.T) {
		if !SameMigrationMarker(nil, nil) {
			t.Fatal("expected SameMigrationMarker(nil, nil) to be true")
		}
		if SameMigrationMarker(nil, markerA1) {
			t.Fatal("expected SameMigrationMarker(nil, marker) to be false")
		}
		if SameMigrationMarker(markerA1, nil) {
			t.Fatal("expected SameMigrationMarker(marker, nil) to be false")
		}
	})

	t.Run("state_mismatches", func(t *testing.T) {
		if SameMigrationMarker(markerA1, completeA) {
			t.Fatal("expected SameMigrationMarker with mismatched state to be false")
		}
		if SameMigrationMarker(completeA, markerA1) {
			t.Fatal("expected SameMigrationMarker with mismatched state to be false")
		}
	})

	t.Run("id_mismatches", func(t *testing.T) {
		if SameMigrationMarker(markerA1, markerB) {
			t.Fatal("expected SameMigrationMarker with mismatched IDs to be false")
		}
		if SameMigrationMarker(completeA, completeB) {
			t.Fatal("expected SameMigrationMarker with mismatched IDs to be false")
		}
	})

	t.Run("both_state_and_id_mismatches", func(t *testing.T) {
		if SameMigrationMarker(markerA1, completeB) {
			t.Fatal("expected SameMigrationMarker with mismatched state and ID to be false")
		}
	})

	t.Run("identical_markers", func(t *testing.T) {
		if !SameMigrationMarker(markerA1, markerA1) {
			t.Fatal("expected SameMigrationMarker for identical pointer to be true")
		}
		if !SameMigrationMarker(markerA1, markerA2) {
			t.Fatal("expected SameMigrationMarker for equal values to be true")
		}
		if !SameMigrationMarker(completeB, &MigrationMarker{State: completeB.State, ID: completeB.ID}) {
			t.Fatal("expected SameMigrationMarker for complete markers to be true")
		}
	})
}

func TestMigrationCompareAndSwap(t *testing.T) {
	t.Run("transition_nil_to_pending_and_pending_to_complete", func(t *testing.T) {
		store, _ := newTestIsolatedStore(t)
		initialHash := "v1$pbkdf2-sha256$600000$c2FsdA$aGFzaA"

		// Initialise config on disk with a password hash and no marker.
		_, err := store.Update(func(cfg *Config) error {
			cfg.AccessPasswordHash = initialHash
			cfg.AccessAuthMigration = nil
			return nil
		})
		if err != nil {
			t.Fatalf("failed to initialise config: %v", err)
		}

		pendingMarker, err := NewMigrationMarker("pending")
		if err != nil {
			t.Fatalf("failed to create pending marker: %v", err)
		}

		// Transition from nil to pending.
		if err := store.CompareAndSwapMigration(nil, initialHash, pendingMarker, initialHash); err != nil {
			t.Fatalf("failed to swap nil to pending: %v", err)
		}

		stored, err := store.ReadAuthoritative()
		if err != nil {
			t.Fatalf("failed to read authoritative config: %v", err)
		}
		if !SameMigrationMarker(stored.AccessAuthMigration, pendingMarker) {
			t.Fatalf("stored marker mismatch: got %+v, want %+v", stored.AccessAuthMigration, pendingMarker)
		}
		if stored.AccessPasswordHash != initialHash {
			t.Fatalf("stored verifier mismatch: got %q, want %q", stored.AccessPasswordHash, initialHash)
		}

		completeMarker, err := NewMigrationMarker("complete")
		if err != nil {
			t.Fatalf("failed to create complete marker: %v", err)
		}

		// Transition from pending to complete, clearing verifier hash as auth.db takes ownership.
		if err := store.CompareAndSwapMigration(pendingMarker, initialHash, completeMarker, ""); err != nil {
			t.Fatalf("failed to swap pending to complete: %v", err)
		}

		storedAfterComplete, err := store.ReadAuthoritative()
		if err != nil {
			t.Fatalf("failed to read authoritative config after complete: %v", err)
		}
		if !SameMigrationMarker(storedAfterComplete.AccessAuthMigration, completeMarker) {
			t.Fatalf("stored marker mismatch: got %+v, want %+v", storedAfterComplete.AccessAuthMigration, completeMarker)
		}
		if storedAfterComplete.AccessPasswordHash != "" {
			t.Fatalf("expected cleared password hash, got %q", storedAfterComplete.AccessPasswordHash)
		}
	})

	t.Run("transition_from_nonexistent_file", func(t *testing.T) {
		store, _ := newTestIsolatedStore(t)
		pendingMarker, err := NewMigrationMarker("pending")
		if err != nil {
			t.Fatalf("failed to create pending marker: %v", err)
		}

		// On a non-existent primary file, expected marker is nil and expected verifier is empty.
		if err := store.CompareAndSwapMigration(nil, "", pendingMarker, "bootstrapped_hash"); err != nil {
			t.Fatalf("failed to CAS non-existent file: %v", err)
		}

		stored, err := store.ReadAuthoritative()
		if err != nil {
			t.Fatalf("failed to read authoritative config: %v", err)
		}
		if !SameMigrationMarker(stored.AccessAuthMigration, pendingMarker) {
			t.Fatalf("stored marker mismatch: got %+v, want %+v", stored.AccessAuthMigration, pendingMarker)
		}
		if stored.AccessPasswordHash != "bootstrapped_hash" {
			t.Fatalf("stored verifier mismatch: got %q, want 'bootstrapped_hash'", stored.AccessPasswordHash)
		}
	})

	t.Run("conflict_detection_marker_mismatch", func(t *testing.T) {
		store, _ := newTestIsolatedStore(t)
		verifier := "verifier_val"
		pendingMarker, err := NewMigrationMarker("pending")
		if err != nil {
			t.Fatal(err)
		}
		competingMarker, err := NewMigrationMarker("pending")
		if err != nil {
			t.Fatal(err)
		}

		_, err = store.Update(func(cfg *Config) error {
			cfg.AccessPasswordHash = verifier
			cfg.AccessAuthMigration = pendingMarker
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}

		// Mismatched expected marker when disk is already pending.
		err = store.CompareAndSwapMigration(nil, verifier, competingMarker, verifier)
		if err == nil {
			t.Fatal("expected conflict error when expected marker is nil but on-disk is pending")
		}
		if !strings.Contains(err.Error(), "auth migration Config changed during startup") {
			t.Fatalf("unexpected error message: %v", err)
		}

		// Expected marker ID differs from on-disk marker ID.
		nextMarker, _ := NewMigrationMarker("complete")
		err = store.CompareAndSwapMigration(competingMarker, verifier, nextMarker, verifier)
		if err == nil {
			t.Fatal("expected conflict error when expected marker ID differs")
		}

		// Expected marker state differs from on-disk marker state.
		mismatchedState := &MigrationMarker{State: "complete", ID: pendingMarker.ID}
		err = store.CompareAndSwapMigration(mismatchedState, verifier, nextMarker, verifier)
		if err == nil {
			t.Fatal("expected conflict error when expected marker state differs")
		}

		// Verify on-disk state was untouched after all failed attempts.
		stored, err := store.ReadAuthoritative()
		if err != nil {
			t.Fatal(err)
		}
		if !SameMigrationMarker(stored.AccessAuthMigration, pendingMarker) {
			t.Fatalf("on-disk marker altered after conflict: got %+v, want %+v", stored.AccessAuthMigration, pendingMarker)
		}
		if stored.AccessPasswordHash != verifier {
			t.Fatalf("on-disk verifier altered after conflict: got %q, want %q", stored.AccessPasswordHash, verifier)
		}
	})

	t.Run("conflict_detection_verifier_mismatch", func(t *testing.T) {
		store, _ := newTestIsolatedStore(t)
		actualVerifier := "actual_hash"
		wrongVerifier := "stale_or_wrong_hash"

		_, err := store.Update(func(cfg *Config) error {
			cfg.AccessPasswordHash = actualVerifier
			cfg.AccessAuthMigration = nil
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}

		pendingMarker, err := NewMigrationMarker("pending")
		if err != nil {
			t.Fatal(err)
		}

		// Verifier does not match on-disk value.
		err = store.CompareAndSwapMigration(nil, wrongVerifier, pendingMarker, actualVerifier)
		if err == nil {
			t.Fatal("expected conflict error when expected password hash differs")
		}
		if !strings.Contains(err.Error(), "auth migration Config changed during startup") {
			t.Fatalf("unexpected error message: %v", err)
		}

		// Verify on-disk state remains unchanged.
		stored, err := store.ReadAuthoritative()
		if err != nil {
			t.Fatal(err)
		}
		if stored.AccessAuthMigration != nil {
			t.Fatalf("on-disk marker unexpectedly modified: %+v", stored.AccessAuthMigration)
		}
		if stored.AccessPasswordHash != actualVerifier {
			t.Fatalf("on-disk verifier unexpectedly modified: got %q, want %q", stored.AccessPasswordHash, actualVerifier)
		}
	})

	t.Run("preserving_unrelated_config_fields", func(t *testing.T) {
		store, _ := newTestIsolatedStore(t)
		initialVerifier := "verifier_preserving_test"
		replayLimit := 16 << 20
		mobileFamily := "Menlo"
		mobileFontSize := 13

		// Initialise config with diverse unrelated fields populated.
		_, err := store.Update(func(cfg *Config) error {
			cfg.ThemeColor = "emerald"
			cfg.UIFontFamily = "JetBrains Mono"
			cfg.UIFontSize = 14
			cfg.TerminalFontFamily = "Fira Code"
			cfg.TerminalFontSize = 12
			cfg.MobileUIFontFamily = &mobileFamily
			cfg.MobileUIFontSize = &mobileFontSize
			cfg.SessionListPageSize = 20
			cfg.HostnameOverride = "box.local"
			cfg.Workspaces = []string{"/custom/workspace/alpha", "/custom/workspace/beta"}
			cfg.ExpandedWorktrees = map[string]bool{"alpha": true, "beta": false}
			cfg.ActiveWorktrees = map[string]string{"alpha": "main", "beta": "develop"}
			cfg.ThinkingPresets = []string{"preset-one", "preset-two"}
			cfg.QuickCommands = []QuickCommand{{Name: "lint", Command: "golangci-lint run"}}
			cfg.TerminalCommands = []QuickCommand{{Name: "monitor", Command: "htop"}}
			cfg.MarkdownDirs = []string{"/docs", "/specs"}
			cfg.AutoReconnect = "always"
			cfg.SyncCoordinator = "http://coordinator.internal:9000"
			cfg.SyncMesh = true
			cfg.AuthOrigins = []string{"https://mesh.local"}
			cfg.Peers = []PeerConfig{{Name: "peer-node-1", URL: "http://peer1:8080"}}
			cfg.OpenCodeIdleStopMinutes = 40
			cfg.ClaudeDangerouslySkipPermissions = true
			cfg.AgyThemeAnsi = true
			cfg.CompressionEnabled = true
			cfg.ReplayBufferBytes = &replayLimit
			cfg.PushoverUserKey = "push-user"
			cfg.PushoverAppToken = "push-app"
			cfg.PushoverEnabled = true
			cfg.WebhookURL = "https://hooks.local/test"
			cfg.WebhookEnabled = true
			cfg.SimplepushKey = "simple-key"
			cfg.SimplepushEnabled = true
			cfg.KanbanUsername = "kanban-user"
			cfg.KanbanURL = "https://kanban.local"
			cfg.KanbanPasswordEnc = "encrypted-payload"

			cfg.AccessPasswordHash = initialVerifier
			cfg.AccessAuthMigration = nil
			return nil
		})
		if err != nil {
			t.Fatalf("failed to initialise store: %v", err)
		}

		baseline, err := store.ReadAuthoritative()
		if err != nil {
			t.Fatalf("failed to read baseline config: %v", err)
		}

		// Perform CAS from nil to pending.
		pendingMarker, err := NewMigrationMarker("pending")
		if err != nil {
			t.Fatalf("failed to create pending marker: %v", err)
		}
		if err := store.CompareAndSwapMigration(nil, initialVerifier, pendingMarker, initialVerifier); err != nil {
			t.Fatalf("CAS nil->pending failed: %v", err)
		}

		afterPending, err := store.ReadAuthoritative()
		if err != nil {
			t.Fatalf("failed to read config after pending CAS: %v", err)
		}
		if !SameMigrationMarker(afterPending.AccessAuthMigration, pendingMarker) {
			t.Fatalf("pending marker not stored properly: %+v", afterPending.AccessAuthMigration)
		}
		if afterPending.AccessPasswordHash != initialVerifier {
			t.Fatalf("password hash altered during pending CAS: got %q, want %q", afterPending.AccessPasswordHash, initialVerifier)
		}

		// Verify every unrelated field was retained without mutation.
		assertUnrelatedFieldsEqual(t, baseline, afterPending)

		// Perform CAS from pending to complete, clearing verifier.
		completeMarker, err := NewMigrationMarker("complete")
		if err != nil {
			t.Fatalf("failed to create complete marker: %v", err)
		}
		if err := store.CompareAndSwapMigration(pendingMarker, initialVerifier, completeMarker, ""); err != nil {
			t.Fatalf("CAS pending->complete failed: %v", err)
		}

		afterComplete, err := store.ReadAuthoritative()
		if err != nil {
			t.Fatalf("failed to read config after complete CAS: %v", err)
		}
		if !SameMigrationMarker(afterComplete.AccessAuthMigration, completeMarker) {
			t.Fatalf("complete marker not stored properly: %+v", afterComplete.AccessAuthMigration)
		}
		if afterComplete.AccessPasswordHash != "" {
			t.Fatalf("password hash expected to be empty, got %q", afterComplete.AccessPasswordHash)
		}

		// Verify all unrelated fields remain completely intact after completion.
		assertUnrelatedFieldsEqual(t, baseline, afterComplete)
	})

	t.Run("unreadable_file_prevents_cas_and_preserves_content", func(t *testing.T) {
		store, path := newTestIsolatedStore(t)
		corruptContent := []byte("[broken toml syntax ===\nnot_valid =")
		if err := os.WriteFile(path, corruptContent, 0o600); err != nil {
			t.Fatal(err)
		}

		marker, err := NewMigrationMarker("pending")
		if err != nil {
			t.Fatal(err)
		}

		err = store.CompareAndSwapMigration(nil, "", marker, "")
		if err == nil {
			t.Fatal("expected CAS to fail when configuration file is corrupt")
		}

		// Verify the unreadable file on disk was not modified or overwritten.
		currentBytes, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatalf("failed reading file after corrupt CAS attempt: %v", readErr)
		}
		if !reflect.DeepEqual(currentBytes, corruptContent) {
			t.Fatalf("corrupted file content altered: got %q, want %q", currentBytes, corruptContent)
		}
	})

	t.Run("failing_writer_aborts_cas", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.toml")
		expectedErr := errors.New("simulated disk write failure")
		failingWriter := func(p string, d []byte, m os.FileMode) error {
			return expectedErr
		}
		store := NewStore(Paths{Primary: path}, failingWriter)

		pendingMarker, err := NewMigrationMarker("pending")
		if err != nil {
			t.Fatal(err)
		}

		err = store.CompareAndSwapMigration(nil, "", pendingMarker, "")
		if err == nil {
			t.Fatal("expected CAS to fail with failing writer")
		}
		if !errors.Is(err, expectedErr) {
			t.Fatalf("expected error %v, got %v", expectedErr, err)
		}
	})
}

func assertUnrelatedFieldsEqual(t *testing.T, want, got Config) {
	t.Helper()

	if got.ThemeColor != want.ThemeColor {
		t.Errorf("ThemeColor mismatch: got %q, want %q", got.ThemeColor, want.ThemeColor)
	}
	if got.UIFontFamily != want.UIFontFamily {
		t.Errorf("UIFontFamily mismatch: got %q, want %q", got.UIFontFamily, want.UIFontFamily)
	}
	if got.UIFontSize != want.UIFontSize {
		t.Errorf("UIFontSize mismatch: got %d, want %d", got.UIFontSize, want.UIFontSize)
	}
	if got.TerminalFontFamily != want.TerminalFontFamily {
		t.Errorf("TerminalFontFamily mismatch: got %q, want %q", got.TerminalFontFamily, want.TerminalFontFamily)
	}
	if got.TerminalFontSize != want.TerminalFontSize {
		t.Errorf("TerminalFontSize mismatch: got %d, want %d", got.TerminalFontSize, want.TerminalFontSize)
	}
	if (got.MobileUIFontFamily == nil) != (want.MobileUIFontFamily == nil) ||
		(got.MobileUIFontFamily != nil && *got.MobileUIFontFamily != *want.MobileUIFontFamily) {
		t.Errorf("MobileUIFontFamily mismatch: got %v, want %v", got.MobileUIFontFamily, want.MobileUIFontFamily)
	}
	if (got.MobileUIFontSize == nil) != (want.MobileUIFontSize == nil) ||
		(got.MobileUIFontSize != nil && *got.MobileUIFontSize != *want.MobileUIFontSize) {
		t.Errorf("MobileUIFontSize mismatch: got %v, want %v", got.MobileUIFontSize, want.MobileUIFontSize)
	}
	if got.SessionListPageSize != want.SessionListPageSize {
		t.Errorf("SessionListPageSize mismatch: got %d, want %d", got.SessionListPageSize, want.SessionListPageSize)
	}
	if got.HostnameOverride != want.HostnameOverride {
		t.Errorf("HostnameOverride mismatch: got %q, want %q", got.HostnameOverride, want.HostnameOverride)
	}
	if !reflect.DeepEqual(got.Workspaces, want.Workspaces) {
		t.Errorf("Workspaces mismatch: got %v, want %v", got.Workspaces, want.Workspaces)
	}
	if !reflect.DeepEqual(got.ExpandedWorktrees, want.ExpandedWorktrees) {
		t.Errorf("ExpandedWorktrees mismatch: got %v, want %v", got.ExpandedWorktrees, want.ExpandedWorktrees)
	}
	if !reflect.DeepEqual(got.ActiveWorktrees, want.ActiveWorktrees) {
		t.Errorf("ActiveWorktrees mismatch: got %v, want %v", got.ActiveWorktrees, want.ActiveWorktrees)
	}
	if !reflect.DeepEqual(got.ThinkingPresets, want.ThinkingPresets) {
		t.Errorf("ThinkingPresets mismatch: got %v, want %v", got.ThinkingPresets, want.ThinkingPresets)
	}
	if !reflect.DeepEqual(got.QuickCommands, want.QuickCommands) {
		t.Errorf("QuickCommands mismatch: got %v, want %v", got.QuickCommands, want.QuickCommands)
	}
	if !reflect.DeepEqual(got.TerminalCommands, want.TerminalCommands) {
		t.Errorf("TerminalCommands mismatch: got %v, want %v", got.TerminalCommands, want.TerminalCommands)
	}
	if !reflect.DeepEqual(got.MarkdownDirs, want.MarkdownDirs) {
		t.Errorf("MarkdownDirs mismatch: got %v, want %v", got.MarkdownDirs, want.MarkdownDirs)
	}
	if got.AutoReconnect != want.AutoReconnect {
		t.Errorf("AutoReconnect mismatch: got %q, want %q", got.AutoReconnect, want.AutoReconnect)
	}
	if got.SyncCoordinator != want.SyncCoordinator {
		t.Errorf("SyncCoordinator mismatch: got %q, want %q", got.SyncCoordinator, want.SyncCoordinator)
	}
	if got.SyncMesh != want.SyncMesh {
		t.Errorf("SyncMesh mismatch: got %v, want %v", got.SyncMesh, want.SyncMesh)
	}
	if !reflect.DeepEqual(got.AuthOrigins, want.AuthOrigins) {
		t.Errorf("AuthOrigins mismatch: got %v, want %v", got.AuthOrigins, want.AuthOrigins)
	}
	if !reflect.DeepEqual(got.Peers, want.Peers) {
		t.Errorf("Peers mismatch: got %v, want %v", got.Peers, want.Peers)
	}
	if got.OpenCodeIdleStopMinutes != want.OpenCodeIdleStopMinutes {
		t.Errorf("OpenCodeIdleStopMinutes mismatch: got %d, want %d", got.OpenCodeIdleStopMinutes, want.OpenCodeIdleStopMinutes)
	}
	if got.ClaudeDangerouslySkipPermissions != want.ClaudeDangerouslySkipPermissions {
		t.Errorf("ClaudeDangerouslySkipPermissions mismatch: got %v, want %v", got.ClaudeDangerouslySkipPermissions, want.ClaudeDangerouslySkipPermissions)
	}
	if got.AgyThemeAnsi != want.AgyThemeAnsi {
		t.Errorf("AgyThemeAnsi mismatch: got %v, want %v", got.AgyThemeAnsi, want.AgyThemeAnsi)
	}
	if got.CompressionEnabled != want.CompressionEnabled {
		t.Errorf("CompressionEnabled mismatch: got %v, want %v", got.CompressionEnabled, want.CompressionEnabled)
	}
	if (got.ReplayBufferBytes == nil) != (want.ReplayBufferBytes == nil) ||
		(got.ReplayBufferBytes != nil && *got.ReplayBufferBytes != *want.ReplayBufferBytes) {
		t.Errorf("ReplayBufferBytes mismatch: got %v, want %v", got.ReplayBufferBytes, want.ReplayBufferBytes)
	}
	if got.PushoverUserKey != want.PushoverUserKey {
		t.Errorf("PushoverUserKey mismatch: got %q, want %q", got.PushoverUserKey, want.PushoverUserKey)
	}
	if got.PushoverAppToken != want.PushoverAppToken {
		t.Errorf("PushoverAppToken mismatch: got %q, want %q", got.PushoverAppToken, want.PushoverAppToken)
	}
	if got.PushoverEnabled != want.PushoverEnabled {
		t.Errorf("PushoverEnabled mismatch: got %v, want %v", got.PushoverEnabled, want.PushoverEnabled)
	}
	if got.WebhookURL != want.WebhookURL {
		t.Errorf("WebhookURL mismatch: got %q, want %q", got.WebhookURL, want.WebhookURL)
	}
	if got.WebhookEnabled != want.WebhookEnabled {
		t.Errorf("WebhookEnabled mismatch: got %v, want %v", got.WebhookEnabled, want.WebhookEnabled)
	}
	if got.SimplepushKey != want.SimplepushKey {
		t.Errorf("SimplepushKey mismatch: got %q, want %q", got.SimplepushKey, want.SimplepushKey)
	}
	if got.SimplepushEnabled != want.SimplepushEnabled {
		t.Errorf("SimplepushEnabled mismatch: got %v, want %v", got.SimplepushEnabled, want.SimplepushEnabled)
	}
	if got.KanbanUsername != want.KanbanUsername {
		t.Errorf("KanbanUsername mismatch: got %q, want %q", got.KanbanUsername, want.KanbanUsername)
	}
	if got.KanbanURL != want.KanbanURL {
		t.Errorf("KanbanURL mismatch: got %q, want %q", got.KanbanURL, want.KanbanURL)
	}
	if got.KanbanPasswordEnc != want.KanbanPasswordEnc {
		t.Errorf("KanbanPasswordEnc mismatch: got %q, want %q", got.KanbanPasswordEnc, want.KanbanPasswordEnc)
	}
}
