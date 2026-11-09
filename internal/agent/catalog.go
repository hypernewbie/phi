package agent

import (
	"errors"
	"fmt"
	"strings"
)

// Effort represents reasoning effort for models that support it.
type Effort string

const (
	EffortLow    Effort = "low"
	EffortMedium Effort = "medium"
	EffortHigh   Effort = "high"
)

// Model describes an Antigravity (agy) model in the catalog.
type Model struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name"`
	Vendor      string `json:"vendor,omitempty"`
	Family      string `json:"family,omitempty"`
	Effort      Effort `json:"effort,omitempty"`
	Description string `json:"description,omitempty"`
}

// ErrHaikuNotSupported indicates that Claude Haiku was requested but is not
// available in the Antigravity (agy) catalog.
var ErrHaikuNotSupported = errors.New("claude haiku is not supported by antigravity; available Claude models: claude-sonnet-5-5-*, claude-opus-5-5-*")

// ErrModelNotFound indicates that the requested model slug is not recognized.
var ErrModelNotFound = errors.New("model not recognized")

// verifiedCatalog contains the verified Antigravity (agy) models as reported by
// the live agy CLI and agy_model_support_plan.md.
var verifiedCatalog = []Model{
	{
		Slug:        "gemini-4-argon-high",
		DisplayName: "Gemini 4 Argon (High)",
		Vendor:      "Google",
		Family:      "gemini-4-argon",
		Effort:      EffortHigh,
		Description: "Gemini 4 Argon with high reasoning effort",
	},
	{
		Slug:        "gemini-4-argon-medium",
		DisplayName: "Gemini 4 Argon (Medium)",
		Vendor:      "Google",
		Family:      "gemini-4-argon",
		Effort:      EffortMedium,
		Description: "Gemini 4 Argon with medium reasoning effort (default)",
	},
	{
		Slug:        "gemini-4-argon-low",
		DisplayName: "Gemini 4 Argon (Low)",
		Vendor:      "Google",
		Family:      "gemini-4-argon",
		Effort:      EffortLow,
		Description: "Gemini 4 Argon with low reasoning effort",
	},
	{
		Slug:        "gemini-3.8-flash-high",
		DisplayName: "Gemini 3.8 Flash (High)",
		Vendor:      "Google",
		Family:      "gemini-3.8-flash",
		Effort:      EffortHigh,
		Description: "Gemini 3.8 Flash with high reasoning effort",
	},
	{
		Slug:        "gemini-3.8-flash-medium",
		DisplayName: "Gemini 3.8 Flash (Medium)",
		Vendor:      "Google",
		Family:      "gemini-3.8-flash",
		Effort:      EffortMedium,
		Description: "Gemini 3.8 Flash with medium reasoning effort (default)",
	},
	{
		Slug:        "gemini-3.8-flash-low",
		DisplayName: "Gemini 3.8 Flash (Low)",
		Vendor:      "Google",
		Family:      "gemini-3.8-flash",
		Effort:      EffortLow,
		Description: "Gemini 3.8 Flash with low reasoning effort",
	},
	{
		Slug:        "claude-opus-5-5-high",
		DisplayName: "Claude Opus 5.5 (High)",
		Vendor:      "Anthropic",
		Family:      "claude-5.5-opus",
		Effort:      EffortHigh,
		Description: "Claude Opus 5.5 with high reasoning effort",
	},
	{
		Slug:        "claude-opus-5-5-medium",
		DisplayName: "Claude Opus 5.5 (Medium)",
		Vendor:      "Anthropic",
		Family:      "claude-5.5-opus",
		Effort:      EffortMedium,
		Description: "Claude Opus 5.5 with medium reasoning effort (default)",
	},
	{
		Slug:        "claude-opus-5-5-low",
		DisplayName: "Claude Opus 5.5 (Low)",
		Vendor:      "Anthropic",
		Family:      "claude-5.5-opus",
		Effort:      EffortLow,
		Description: "Claude Opus 5.5 with low reasoning effort",
	},
	{
		Slug:        "claude-sonnet-5-5-high",
		DisplayName: "Claude Sonnet 5.5 (High)",
		Vendor:      "Anthropic",
		Family:      "claude-5.5-sonnet",
		Effort:      EffortHigh,
		Description: "Claude Sonnet 5.5 with high reasoning effort",
	},
	{
		Slug:        "claude-sonnet-5-5-medium",
		DisplayName: "Claude Sonnet 5.5 (Medium)",
		Vendor:      "Anthropic",
		Family:      "claude-5.5-sonnet",
		Effort:      EffortMedium,
		Description: "Claude Sonnet 5.5 with medium reasoning effort (default)",
	},
	{
		Slug:        "claude-sonnet-5-5-low",
		DisplayName: "Claude Sonnet 5.5 (Low)",
		Vendor:      "Anthropic",
		Family:      "claude-5.5-sonnet",
		Effort:      EffortLow,
		Description: "Claude Sonnet 5.5 with low reasoning effort",
	},
	{
		Slug:        "gpt-oss-120b-medium",
		DisplayName: "GPT-OSS 120B (Medium)",
		Vendor:      "OpenAI",
		Family:      "gpt-oss-120b",
		Effort:      EffortMedium,
		Description: "Open-weight 120B model on Antigravity",
	},
}

// aliasMap normalizes common variants and base model names to exact verified slugs.
var aliasMap = map[string]string{
	// Gemini base models default to medium effort
	"gemini-4-argon":       "gemini-4-argon-medium",
	"gemini-4-argon-med":   "gemini-4-argon-medium",
	"gemini-3.8-flash":     "gemini-3.8-flash-medium",
	"gemini-3.8-flash-med": "gemini-3.8-flash-medium",

	// Claude Sonnet variants
	"claude-5.5-sonnet":        "claude-sonnet-5-5-medium",
	"claude-5.5-sonnet-high":   "claude-sonnet-5-5-high",
	"claude-5.5-sonnet-medium": "claude-sonnet-5-5-medium",
	"claude-5.5-sonnet-med":    "claude-sonnet-5-5-medium",
	"claude-5.5-sonnet-low":    "claude-sonnet-5-5-low",
	"claude-sonnet-5-5":        "claude-sonnet-5-5-medium",
	"claude-sonnet-5-5-med":    "claude-sonnet-5-5-medium",

	// Claude Opus variants
	"claude-5.5-opus":        "claude-opus-5-5-medium",
	"claude-5.5-opus-high":   "claude-opus-5-5-high",
	"claude-5.5-opus-medium": "claude-opus-5-5-medium",
	"claude-5.5-opus-med":    "claude-opus-5-5-medium",
	"claude-5.5-opus-low":    "claude-opus-5-5-low",
	"claude-opus-5-5":        "claude-opus-5-5-medium",
	"claude-opus-5-5-med":    "claude-opus-5-5-medium",

	// GPT-OSS base variant
	"gpt-oss-120b":     "gpt-oss-120b-medium",
	"gpt-oss-120b-med": "gpt-oss-120b-medium",
}

var catalogBySlug map[string]Model

func init() {
	catalogBySlug = make(map[string]Model, len(verifiedCatalog))
	for _, m := range verifiedCatalog {
		catalogBySlug[m.Slug] = m
	}
}

// Catalog returns a copy of all verified models in canonical order.
func Catalog() []Model {
	out := make([]Model, len(verifiedCatalog))
	copy(out, verifiedCatalog)
	return out
}

// Slugs returns the list of exact canonical model slug strings.
func Slugs() []string {
	out := make([]string, len(verifiedCatalog))
	for i, m := range verifiedCatalog {
		out[i] = m.Slug
	}
	return out
}

// Lookup returns the model definition for the given slug or alias, and whether it was found.
func Lookup(slugOrAlias string) (Model, bool) {
	norm, err := NormalizeSlug(slugOrAlias)
	if err != nil {
		return Model{}, false
	}
	m, ok := catalogBySlug[norm]
	return m, ok
}

// DisplayName returns the human-readable display name for a model slug,
// or the original slug if not recognized.
func DisplayName(slug string) string {
	if m, ok := Lookup(slug); ok {
		return m.DisplayName
	}
	return slug
}

// IsKnownSlug reports whether slug is an exact canonical verified slug.
func IsKnownSlug(slug string) bool {
	_, ok := catalogBySlug[strings.TrimSpace(strings.ToLower(slug))]
	return ok
}

// NormalizeSlug trims whitespace, normalizes casing, maps known aliases to their
// canonical slug, and validates against the catalog.
func NormalizeSlug(input string) (string, error) {
	s := strings.TrimSpace(strings.ToLower(input))
	if s == "" {
		return "", fmt.Errorf("%w: empty model slug", ErrModelNotFound)
	}

	// Specific check for Claude Haiku variants to provide a clear, helpful error message.
	if strings.Contains(s, "haiku") {
		return "", ErrHaikuNotSupported
	}

	// Direct match in catalog
	if _, ok := catalogBySlug[s]; ok {
		return s, nil
	}

	// Check alias map
	if target, ok := aliasMap[s]; ok {
		return target, nil
	}

	return "", fmt.Errorf("%w: %q (available models: %s)", ErrModelNotFound, input, strings.Join(Slugs(), ", "))
}

// ValidateModel checks if the input is a valid slug or alias and returns its Model.
func ValidateModel(slugOrAlias string) (Model, error) {
	canonical, err := NormalizeSlug(slugOrAlias)
	if err != nil {
		return Model{}, err
	}
	m, ok := catalogBySlug[canonical]
	if !ok {
		return Model{}, fmt.Errorf("%w: %q", ErrModelNotFound, canonical)
	}
	return m, nil
}

// ValidateSlug checks if the input is a valid model slug.
func ValidateSlug(slug string) error {
	_, err := NormalizeSlug(slug)
	return err
}
