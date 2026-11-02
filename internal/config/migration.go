package config

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"

	"github.com/BurntSushi/toml"
)

// MigrationMarker makes the Config/SQLite import crash-recoverable. Its ID is
// random but non-secret; the verifier and all sessions remain in auth.db.
type MigrationMarker struct {
	State string `json:"state" toml:"state"`
	ID    string `json:"id" toml:"id"`
}

// NewMigrationMarker returns a marker in state ("pending" or "complete") with
// a fresh random ID.
func NewMigrationMarker(state string) (*MigrationMarker, error) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	marker := &MigrationMarker{State: state, ID: base64.RawURLEncoding.EncodeToString(id)}
	if _, err := MigrationMarkerID(marker); err != nil {
		return nil, err
	}
	return marker, nil
}

// SameMigrationMarker reports whether two markers are identical, treating nil
// as a value.
func SameMigrationMarker(a, b *MigrationMarker) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.State == b.State && a.ID == b.ID
}

// MigrationMarkerID validates the marker and returns its 16-byte ID.
func MigrationMarkerID(marker *MigrationMarker) ([16]byte, error) {
	var id [16]byte
	if marker == nil || (marker.State != "pending" && marker.State != "complete") {
		return id, errors.New("invalid auth migration marker state")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(marker.ID)
	if err != nil || len(decoded) != len(id) || base64.RawURLEncoding.EncodeToString(decoded) != marker.ID {
		return id, errors.New("invalid auth migration marker ID")
	}
	copy(id[:], decoded)
	return id, nil
}

// validateMigrationTOML rejects a marker table that is partial, has unknown
// keys, or decodes to a marker the struct did not capture.
func validateMigrationTOML(metadata toml.MetaData, cfg Config) error {
	fields := make(map[string]bool, 2)
	present := false
	for _, key := range metadata.Keys() {
		if len(key) == 0 || key[0] != "access_auth_migration" {
			continue
		}
		present = true
		if len(key) == 1 {
			continue
		}
		if len(key) != 2 || (key[1] != "state" && key[1] != "id") {
			return errors.New("invalid auth migration marker key")
		}
		fields[key[1]] = true
	}
	if !present {
		if cfg.AccessAuthMigration != nil {
			return errors.New("invalid auth migration marker")
		}
		return nil
	}
	if cfg.AccessAuthMigration == nil || !fields["state"] || !fields["id"] || len(fields) != 2 {
		return errors.New("invalid auth migration marker")
	}
	if _, err := MigrationMarkerID(cfg.AccessAuthMigration); err != nil {
		return err
	}
	return nil
}

// decodeMigrationJSON decodes the legacy JSON config, validating the marker
// table strictly so an unknown or partial marker never loads as valid.
func decodeMigrationJSON(raw []byte, cfg *Config) error {
	if err := ValidateJSONValue(raw, true); err != nil {
		return err
	}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return err
	}
	markerRaw, ok := top["access_auth_migration"]
	if !ok {
		return nil
	}
	var marker MigrationMarker
	decoder := json.NewDecoder(bytes.NewReader(markerRaw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&marker); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("invalid auth migration marker")
	}
	if _, err := MigrationMarkerID(&marker); err != nil {
		return err
	}
	cfg.AccessAuthMigration = &marker
	return nil
}

// ValidateJSONValue rejects trailing values, duplicate object keys, and
// non-object roots when objectOnly is set. It started as the strict decoder
// for the legacy JSON config; auth reuses it for request bodies.
func ValidateJSONValue(raw []byte, objectOnly bool) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil {
		return err
	}
	if objectOnly && first != json.Delim('{') {
		return errors.New("configuration must be one JSON object")
	}
	if err := scanJSONValue(decoder, first); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder, token json.Token) error {
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return errors.New("duplicate JSON object key")
			}
			seen[key] = struct{}{}
			value, err := decoder.Token()
			if err != nil {
				return err
			}
			if err := scanJSONValue(decoder, value); err != nil {
				return err
			}
		}
		close, err := decoder.Token()
		if err != nil || close != json.Delim('}') {
			return errors.New("invalid JSON object")
		}
	case '[':
		for decoder.More() {
			value, err := decoder.Token()
			if err != nil {
				return err
			}
			if err := scanJSONValue(decoder, value); err != nil {
				return err
			}
		}
		close, err := decoder.Token()
		if err != nil || close != json.Delim(']') {
			return errors.New("invalid JSON array")
		}
	default:
		return errors.New("invalid JSON delimiter")
	}
	return nil
}
