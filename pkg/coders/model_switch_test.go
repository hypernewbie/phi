package coders

import (
	"path/filepath"
	"strings"
	"testing"
)

// Declarative model_switch recipes let a custom backend (e.g. a gemini
// CLI profile) drive the Models preset dropup through the bounded
// executor — no recompilation, no guessed /model command.

func TestValidateModelSwitch_Bounds(t *testing.T) {
	good := []ModelSwitchStep{{Send: "/model set {model}\r"}}
	if err := ValidateModelSwitch(good); err != nil {
		t.Fatalf("valid recipe rejected: %v", err)
	}
	if err := ValidateModelSwitch(nil); err == nil {
		t.Fatal("empty recipe should be rejected")
	}
	if err := ValidateModelSwitch([]ModelSwitchStep{}); err == nil {
		t.Fatal("empty recipe should be rejected")
	}
	if err := ValidateModelSwitch([]ModelSwitchStep{{Send: ""}}); err == nil {
		t.Fatal("empty send should be rejected")
	}
	if err := ValidateModelSwitch([]ModelSwitchStep{{Send: "/x", DelayMs: -1}}); err == nil {
		t.Fatal("negative delay should be rejected")
	}
	big := []ModelSwitchStep{{Send: strings.Repeat("x", MaxModelSwitchStepBytes+1)}}
	if err := ValidateModelSwitch(big); err == nil {
		t.Fatal("oversized step should be rejected")
	}
	many := make([]ModelSwitchStep, MaxModelSwitchSteps+1)
	for i := range many {
		many[i] = ModelSwitchStep{Send: "/x"}
	}
	if err := ValidateModelSwitch(many); err == nil {
		t.Fatal("too many steps should be rejected")
	}
	slow := []ModelSwitchStep{
		{Send: "/a", DelayMs: MaxModelSwitchTotalMs},
		{Send: "/b", DelayMs: 1},
	}
	if err := ValidateModelSwitch(slow); err == nil {
		t.Fatal("excessive total delay should be rejected")
	}
}

func TestCoderPatch_ApplyModelSwitch(t *testing.T) {
	base := Coder{ID: "gemini", Name: "Gemini", Command: "gemini", InputMode: "staged"}
	steps := []ModelSwitchStep{{Send: "/model set {model}\r"}}
	got, err := (&CoderPatch{ModelSwitch: &steps}).Apply(base)
	if err != nil {
		t.Fatalf("Apply rejected a valid recipe: %v", err)
	}
	if len(got.ModelSwitch) != 1 || got.ModelSwitch[0].Send != "/model set {model}\r" {
		t.Fatalf("recipe not applied: %v", got.ModelSwitch)
	}
	// Mutating the patch input afterwards must not alias the result.
	steps[0].Send = "/mutated"
	if got.ModelSwitch[0].Send == "/mutated" {
		t.Fatal("Apply aliased the patch slice")
	}
	// Empty array clears; invalid recipes reject the file.
	empty := []ModelSwitchStep{}
	withRecipe, err := (&CoderPatch{ModelSwitch: &steps}).Apply(base)
	if err != nil {
		t.Fatal(err)
	}
	withRecipe.ModelSwitch[0].Send = "/model set {model}\r"
	cleared, err := (&CoderPatch{ModelSwitch: &empty}).Apply(withRecipe)
	if err != nil {
		t.Fatalf("clear rejected: %v", err)
	}
	if cleared.ModelSwitch != nil {
		t.Fatalf("empty array should clear the recipe: %v", cleared.ModelSwitch)
	}
	bad := []ModelSwitchStep{{Send: ""}}
	if _, err := (&CoderPatch{ModelSwitch: &bad}).Apply(base); err == nil {
		t.Fatal("invalid recipe should reject the patch")
	}
}

func TestLoadFromDir_ModelSwitchGemini(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "gemini.json"), `{
		"id": "gemini",
		"name": "Gemini",
		"command": "gemini",
		"input_mode": "staged",
		"sidebar_visible": true,
		"model_switch": [{"send": "/model set {model}\r"}]
	}`)

	m := NewManager()
	warned := false
	if err := m.LoadFromDir(dir, func(string) { warned = true }); err != nil {
		t.Fatal(err)
	}
	if warned {
		t.Fatal("no warnings expected on a well-formed recipe file")
	}
	c, ok := m.Get("gemini")
	if !ok {
		t.Fatal("gemini should have been added")
	}
	if len(c.ModelSwitch) != 1 || c.ModelSwitch[0].Send != "/model set {model}\r" {
		t.Fatalf("gemini recipe wrong: %v", c.ModelSwitch)
	}
	d := c.Descriptor()
	if len(d.ModelSwitch) != 1 || d.ModelSwitch[0].Send != "/model set {model}\r" {
		t.Fatalf("descriptor must carry the recipe to the browser: %v", d.ModelSwitch)
	}
	// Descriptor must be a copy: mutating it cannot corrupt the registry.
	d.ModelSwitch[0].Send = "/mutated"
	again, _ := m.Get("gemini")
	if again.ModelSwitch[0].Send != "/model set {model}\r" {
		t.Fatal("descriptor aliased registry state")
	}
}

func TestLoadFromDir_ModelSwitchInvalidSkipped(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "bad.json"), `{
		"id": "badcli",
		"name": "Bad",
		"command": "badcli",
		"model_switch": [{"send": ""}]
	}`)

	m := NewManager()
	warned := false
	if err := m.LoadFromDir(dir, func(string) { warned = true }); err != nil {
		t.Fatal(err)
	}
	if !warned {
		t.Fatal("expected a warning for an invalid recipe")
	}
	if _, ok := m.Get("badcli"); ok {
		t.Fatal("backend with invalid recipe must be skipped")
	}
}
