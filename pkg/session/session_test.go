package session

import (
	"testing"
	"time"
)

func TestParseRawTime(t *testing.T) {
	// Test Unix seconds (int64)
	sec := int64(1700000000)
	parsedSec := parseRawTime(sec)
	if parsedSec.Unix() != sec {
		t.Errorf("Expected unix time %d, got %d", sec, parsedSec.Unix())
	}

	// Test Unix milliseconds (int64)
	ms := int64(1700000000000)
	parsedMs := parseRawTime(ms)
	if parsedMs.Unix() != sec {
		t.Errorf("Expected unix time from milliseconds %d, got %d", sec, parsedMs.Unix())
	}

	// Test RFC3339 string
	str := "2026-05-31T07:57:06Z"
	parsedStr := parseRawTime(str)
	if parsedStr.Format(time.RFC3339) != str {
		t.Errorf("Expected parsed time format %q, got %q", str, parsedStr.Format(time.RFC3339))
	}
}

func TestDecodeClaudePath(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"-home-hypernewbie-code-util", "/home/hypernewbie/code/util"},
		{"-home-user-project", "/home/user/project"},
		{"some-path", "some/path"},
	}

	for _, c := range cases {
		result := decodeClaudePath(c.input)
		if result != c.expected {
			t.Errorf("decodeClaudePath(%q) = %q; expected %q", c.input, result, c.expected)
		}
	}
}

func TestListAgySessionsRobutness(t *testing.T) {
	// Verify that ListAgySessions runs fine even if directory is empty or path doesn't exist
	sessions, err := ListAgySessions("/home/hypernewbie/code/nonexistent")
	if err != nil {
		t.Fatalf("Unexpected error listing agy sessions: %v", err)
	}
	// We shouldn't crash or return nil if conversations dir doesn't exist
	if sessions == nil {
		t.Error("Expected empty sessions slice, got nil")
	}
}
