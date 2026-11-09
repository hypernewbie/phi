package agent

import (
	"errors"
	"strings"
	"testing"
)

func TestCatalogModelsCountAndProperties(t *testing.T) {
	cat := Catalog()
	if len(cat) != 13 {
		t.Fatalf("expected 13 models in verified catalog, got %d", len(cat))
	}

	expectedSlugs := []string{
		"gemini-4-argon-high",
		"gemini-4-argon-medium",
		"gemini-4-argon-low",
		"gemini-3.8-flash-high",
		"gemini-3.8-flash-medium",
		"gemini-3.8-flash-low",
		"claude-opus-5-5-high",
		"claude-opus-5-5-medium",
		"claude-opus-5-5-low",
		"claude-sonnet-5-5-high",
		"claude-sonnet-5-5-medium",
		"claude-sonnet-5-5-low",
		"gpt-oss-120b-medium",
	}

	slugs := Slugs()
	if len(slugs) != len(expectedSlugs) {
		t.Fatalf("Slugs() count mismatch: got %d, want %d", len(slugs), len(expectedSlugs))
	}

	for i, want := range expectedSlugs {
		if slugs[i] != want {
			t.Errorf("Slugs()[%d] = %q, want %q", i, slugs[i], want)
		}
		if cat[i].Slug != want {
			t.Errorf("Catalog()[%d].Slug = %q, want %q", i, cat[i].Slug, want)
		}
		if cat[i].DisplayName == "" {
			t.Errorf("Catalog()[%d] has empty DisplayName", i)
		}
		if cat[i].Vendor == "" {
			t.Errorf("Catalog()[%d] has empty Vendor", i)
		}
	}
}

func TestDisplayNamesMatchVerified(t *testing.T) {
	tests := []struct {
		slug            string
		wantDisplayName string
	}{
		{"gemini-4-argon-high", "Gemini 4 Argon (High)"},
		{"gemini-4-argon-medium", "Gemini 4 Argon (Medium)"},
		{"gemini-4-argon-low", "Gemini 4 Argon (Low)"},
		{"gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"},
		{"gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"},
		{"gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"},
		{"claude-opus-5-5-high", "Claude Opus 5.5 (High)"},
		{"claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"},
		{"claude-opus-5-5-low", "Claude Opus 5.5 (Low)"},
		{"claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"},
		{"claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"},
		{"claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"},
		{"gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"},
	}

	for _, tc := range tests {
		t.Run(tc.slug, func(t *testing.T) {
			got := DisplayName(tc.slug)
			if got != tc.wantDisplayName {
				t.Errorf("DisplayName(%q) = %q, want %q", tc.slug, got, tc.wantDisplayName)
			}
		})
	}
}

func TestLookupAndIsKnownSlug(t *testing.T) {
	for _, slug := range Slugs() {
		m, ok := Lookup(slug)
		if !ok {
			t.Errorf("Lookup(%q) returned false, want true", slug)
		}
		if m.Slug != slug {
			t.Errorf("Lookup(%q).Slug = %q", slug, m.Slug)
		}
		if !IsKnownSlug(slug) {
			t.Errorf("IsKnownSlug(%q) = false, want true", slug)
		}
	}

	if IsKnownSlug("non-existent-model") {
		t.Error("IsKnownSlug(non-existent-model) = true, want false")
	}
	if _, ok := Lookup("non-existent-model"); ok {
		t.Error("Lookup(non-existent-model) returned true, want false")
	}
}

func TestAliasNormalization(t *testing.T) {
	aliases := []struct {
		input          string
		wantNormalized string
	}{
		// Gemini base names map to default medium effort
		{"gemini-4-argon", "gemini-4-argon-medium"},
		{"gemini-4-argon-med", "gemini-4-argon-medium"},
		{"gemini-3.8-flash", "gemini-3.8-flash-medium"},
		{"gemini-3.8-flash-med", "gemini-3.8-flash-medium"},

		// Claude Sonnet variants
		{"claude-5.5-sonnet", "claude-sonnet-5-5-medium"},
		{"claude-5.5-sonnet-high", "claude-sonnet-5-5-high"},
		{"claude-5.5-sonnet-medium", "claude-sonnet-5-5-medium"},
		{"claude-5.5-sonnet-low", "claude-sonnet-5-5-low"},
		{"claude-sonnet-5-5", "claude-sonnet-5-5-medium"},

		// Claude Opus variants
		{"claude-5.5-opus", "claude-opus-5-5-medium"},
		{"claude-5.5-opus-high", "claude-opus-5-5-high"},
		{"claude-5.5-opus-medium", "claude-opus-5-5-medium"},
		{"claude-5.5-opus-low", "claude-opus-5-5-low"},
		{"claude-opus-5-5", "claude-opus-5-5-medium"},

		// GPT-OSS
		{"gpt-oss-120b", "gpt-oss-120b-medium"},
		{"gpt-oss-120b-med", "gpt-oss-120b-medium"},

		// Case & whitespace
		{"  GEMINI-4-ARGON-HIGH  ", "gemini-4-argon-high"},
		{"Claude-5.5-Sonnet", "claude-sonnet-5-5-medium"},
	}

	for _, tc := range aliases {
		t.Run(tc.input, func(t *testing.T) {
			got, err := NormalizeSlug(tc.input)
			if err != nil {
				t.Fatalf("NormalizeSlug(%q) unexpected error: %v", tc.input, err)
			}
			if got != tc.wantNormalized {
				t.Errorf("NormalizeSlug(%q) = %q, want %q", tc.input, got, tc.wantNormalized)
			}

			// ValidateModel also resolves aliases
			m, err := ValidateModel(tc.input)
			if err != nil {
				t.Fatalf("ValidateModel(%q) unexpected error: %v", tc.input, err)
			}
			if m.Slug != tc.wantNormalized {
				t.Errorf("ValidateModel(%q).Slug = %q, want %q", tc.input, m.Slug, tc.wantNormalized)
			}

			// Lookup also resolves aliases
			mLookup, ok := Lookup(tc.input)
			if !ok || mLookup.Slug != tc.wantNormalized {
				t.Errorf("Lookup(%q) = (%v, %v), want slug %q", tc.input, mLookup.Slug, ok, tc.wantNormalized)
			}
		})
	}
}

func TestClaudeHaikuExplicitlyRejected(t *testing.T) {
	haikuInputs := []string{
		"claude-5.5-haiku",
		"claude-haiku",
		"claude-haiku-5-5",
		"haiku",
		"Claude-5.5-Haiku-High",
	}

	for _, input := range haikuInputs {
		t.Run(input, func(t *testing.T) {
			_, err := NormalizeSlug(input)
			if !errors.Is(err, ErrHaikuNotSupported) {
				t.Errorf("NormalizeSlug(%q) err = %v, want ErrHaikuNotSupported", input, err)
			}

			err = ValidateSlug(input)
			if !errors.Is(err, ErrHaikuNotSupported) {
				t.Errorf("ValidateSlug(%q) err = %v, want ErrHaikuNotSupported", input, err)
			}

			_, err = ValidateModel(input)
			if !errors.Is(err, ErrHaikuNotSupported) {
				t.Errorf("ValidateModel(%q) err = %v, want ErrHaikuNotSupported", input, err)
			}
		})
	}
}

func TestInvalidAndEmptySlugs(t *testing.T) {
	invalidInputs := []string{
		"",
		"   ",
		"non-existent-slug",
		"gemini-1.5-pro", // deprecated legacy slug
		"gpt-4o",
	}

	for _, input := range invalidInputs {
		t.Run(input, func(t *testing.T) {
			_, err := NormalizeSlug(input)
			if err == nil {
				t.Errorf("NormalizeSlug(%q) expected error, got nil", input)
			}
			if !errors.Is(err, ErrModelNotFound) {
				t.Errorf("NormalizeSlug(%q) err = %v, want ErrModelNotFound", input, err)
			}
			if input != "" && input != "   " {
				// Error message should list available models
				if !strings.Contains(err.Error(), "available models:") {
					t.Errorf("NormalizeSlug(%q) error should list available models, got %q", input, err.Error())
				}
			}
		})
	}
}
