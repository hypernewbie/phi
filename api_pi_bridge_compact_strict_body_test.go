package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestCompactStrictBody(t *testing.T) {
	valid := `{"pane":"unknown","generation":"1","telemetry_revision":"1"}`
	for name, suffix := range map[string]string{
		"extra-close-object":  "}",
		"extra-close-array":   "]",
		"oversize-whitespace": strings.Repeat(" ", 5000),
	} {
		t.Run(name, func(t *testing.T) {
			rec := serveCompact(t, valid+suffix, nil)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("body passed decoding: status %d; want 400", rec.Code)
			}
		})
	}
}
