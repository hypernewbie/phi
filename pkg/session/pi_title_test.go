package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPiPromptTitleStringAndTextBlocks(t *testing.T) {
	stringContent := json.RawMessage(`"/skill:build\nPlease improve the renderer"`)
	blockContent := json.RawMessage(`[{"type":"image","data":"ignored"},{"type":"text","text":"/skill:build"},{"type":"text","text":"Please improve the renderer"}]`)
	before := append(json.RawMessage(nil), blockContent...)

	stringTitle := PiPromptTitle(stringContent)
	blockTitle := PiPromptTitle(blockContent)
	if stringTitle != "Please improve the renderer" || blockTitle != stringTitle {
		t.Fatalf("string title=%q, text-block title=%q", stringTitle, blockTitle)
	}
	if !bytes.Equal(blockContent, before) {
		t.Fatal("PiPromptTitle mutated its input bytes")
	}
}

func TestPiPromptTitleCleansSkillPrefixesBeforeTruncation(t *testing.T) {
	longSkill := strings.Repeat("long skill instruction ", 40)
	wrapped := "  <skill name=\"review\" location=\"/skills/review.md\">\r\n" +
		longSkill + "\r\n</skill>\r\n" +
		"/skill:format\n<skill name=\"format\" location=\"/skills/format.md\">\n" +
		"more instructions\n</skill>\n" +
		"Implement the requested feature"

	if got := PiPromptTitle(json.RawMessage(mustJSONString(t, wrapped))); got != "Implement the requested feature" {
		t.Fatalf("title after expanded skill prefixes = %q", got)
	}
	if got := PiPromptTitle(json.RawMessage(`"/skill:first /skill:second Fix the task"`)); got != "Fix the task" {
		t.Fatalf("title after successive raw prefixes = %q", got)
	}
}

func TestPiPromptTitleIgnoresInstructionOnlyAndIncompleteSkill(t *testing.T) {
	completeSkill := "<skill name=\"only\" location=\"/skills/only.md\">\n" +
		strings.Repeat("instruction ", 80) + "\n</skill>"
	if got := PiPromptTitle(json.RawMessage(mustJSONString(t, completeSkill))); got != "" {
		t.Fatalf("skill-only title = %q, want empty", got)
	}
	if got := PiPromptTitle(json.RawMessage(`"/skill:only"`)); got != "" {
		t.Fatalf("raw skill-only title = %q, want empty", got)
	}

	incomplete := "<skill name=\"unfinished\" location=\"/skills/unfinished.md\">\n" +
		strings.Repeat("private instruction ", 80) + "\nActual request appears before no closing marker"
	if got := PiPromptTitle(json.RawMessage(mustJSONString(t, incomplete))); got != "" {
		t.Fatalf("incomplete skill exposed title text: %q", got)
	}
}

func TestPiPromptTitlePreservesOrdinaryXMLAndExamples(t *testing.T) {
	cases := []struct {
		name string
		text string
		want string
	}{
		{name: "ordinary XML", text: "Keep <tag>literal</tag> text", want: "Keep <tag>literal</tag> text"},
		{name: "bare skill prefix", text: "/skill:", want: "/skill:"},
		{name: "quoted wrapper example", text: "Example: `<skill>` stays literal", want: "Example: `<skill>` stays literal"},
		{name: "fenced wrapper example", text: "Example: ```<skill>``` stay literal", want: "Example: ```<skill>``` stay literal"},
		{name: "wrapper-like text after request", text: "Say <skill name=\"x\" location=\"y\">", want: "Say <skill name=\"x\" location=\"y\">"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := PiPromptTitle(json.RawMessage(mustJSONString(t, test.text)))
			if got != test.want {
				t.Fatalf("PiPromptTitle() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestPiPromptTitleTruncatesByUnicodeCodePoint(t *testing.T) {
	ascii36 := strings.Repeat("a", 36)
	if got := PiPromptTitle(json.RawMessage(mustJSONString(t, ascii36))); got != ascii36 {
		t.Fatalf("36-character title = %q", got)
	}
	if got, want := PiPromptTitle(json.RawMessage(mustJSONString(t, ascii36+"b"))), ascii36+"..."; got != want {
		t.Fatalf("37-character title = %q, want %q", got, want)
	}

	unicode36 := strings.Repeat("é", 36)
	got := PiPromptTitle(json.RawMessage(mustJSONString(t, unicode36+"界")))
	if want := unicode36 + "..."; got != want {
		t.Fatalf("Unicode title = %q, want %q", got, want)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("truncated title is invalid UTF-8: %q", got)
	}
}

func TestPiTitleStateUsesLatestNameAndClearsToFirstUsefulPrompt(t *testing.T) {
	var state PiTitleState
	applyTitleRecord(t, &state, `{"type":"session_info","name":" First  native name "}`)
	applyTitleRecord(t, &state, `{"type":"message","message":{"role":"user","content":"/skill:only"}}`)
	if state.Prompt != "" {
		t.Fatalf("instruction-only message set fallback %q", state.Prompt)
	}
	applyTitleRecord(t, &state, `{"type":"msg","message":{"role":"user","content":[{"type":"text","text":"Build"},{"type":"text","text":" the feature"}]}}`)
	applyTitleRecord(t, &state, `{"type":"message","message":{"role":"user","content":"later request"}}`)
	if state.Prompt != "Build the feature" {
		t.Fatalf("first useful prompt = %q", state.Prompt)
	}
	if state.Title() != "First  native name" {
		t.Fatalf("latest native title = %q", state.Title())
	}

	applyTitleRecord(t, &state, `{"type":"session_info","name":"Second   native name"}`)
	if state.Title() != "Second   native name" {
		t.Fatalf("later native name = %q", state.Title())
	}
	applyTitleRecord(t, &state, `{"type":"session_info","name":null}`)
	if state.Name != "" || state.Title() != "Build the feature" {
		t.Fatalf("native clear did not reveal retained fallback: %+v, title=%q", state, state.Title())
	}
}

func TestPiTitleStateClearsMissingAndBlankNames(t *testing.T) {
	cases := []struct {
		name   string
		record string
	}{
		{name: "missing", record: `{"type":"session_info"}`},
		{name: "null", record: `{"type":"session_info","name":null}`},
		{name: "empty", record: `{"type":"session_info","name":""}`},
		{name: "whitespace", record: `{"type":"session_info","name":" \t\n "}`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			state := PiTitleState{Name: "Native name", Prompt: "request fallback"}
			applyTitleRecord(t, &state, test.record)
			if state.Name != "" || state.Title() != "request fallback" {
				t.Fatalf("clear record left state %+v, title=%q", state, state.Title())
			}
		})
	}
}

func TestPiTitleStateIgnoresNonStringNamesAndMalformedRecords(t *testing.T) {
	for _, name := range []string{`17`, `false`, `{}`, `[]`} {
		t.Run(name, func(t *testing.T) {
			state := PiTitleState{Name: "Keep this name", Prompt: "request fallback"}
			applyTitleRecord(t, &state, `{"type":"session_info","name":`+name+`}`)
			if state.Name != "Keep this name" || state.Title() != "Keep this name" {
				t.Fatalf("non-string name cleared valid state: %+v", state)
			}
			if err := state.applyRecord([]byte(`{"type":"session_info","name":"other"`)); err == nil {
				t.Fatal("malformed JSON record returned no error")
			}
			if state.Name != "Keep this name" || state.Prompt != "request fallback" {
				t.Fatalf("malformed record changed state: %+v", state)
			}
		})
	}
}

func TestPiTitleStateAcceptsCurrentAndLegacyUserMessages(t *testing.T) {
	for _, recordType := range []string{"message", "msg"} {
		t.Run(recordType, func(t *testing.T) {
			var state PiTitleState
			applyTitleRecord(t, &state, `{"type":"`+recordType+`","message":{"role":"user","content":"Do the work"}}`)
			if state.Prompt != "Do the work" || state.Title() != "Do the work" {
				t.Fatalf("user message title state = %+v", state)
			}
		})
	}
}

func TestPiTitleStatePreservesFullNativeNameAndInternalWhitespace(t *testing.T) {
	name := strings.Repeat("long", 20) + "  with  spacing"
	var state PiTitleState
	applyTitleRecord(t, &state, `{"type":"session_info","name":`+mustJSONString(t, "  "+name+"  ")+`}`)
	if state.Name != name || state.Title() != name {
		t.Fatalf("native name was changed or truncated: %q", state.Name)
	}
}

func TestPiRecordDecoderRecoversAfterOversizedRecord(t *testing.T) {
	var decoder piRecordDecoder
	var records []string
	valid := `{"type":"session_info","name":"Recovered"}`
	input := append([]byte(strings.Repeat("x", maxPiTitleRecordBytes+1)+"\n"), []byte(valid+"\n")...)
	warning := decoder.Feed(input, false, func(record []byte) error {
		records = append(records, string(record))
		return nil
	})
	if !errors.Is(warning, errPiTitleRecordTooLarge) {
		t.Fatalf("oversized-record warning = %v", warning)
	}
	if len(records) != 1 || records[0] != valid {
		t.Fatalf("records after oversized input = %#v", records)
	}
}

func applyTitleRecord(t *testing.T, state *PiTitleState, record string) {
	t.Helper()
	if err := state.applyRecord([]byte(record)); err != nil {
		t.Fatalf("apply title record: %v", err)
	}
}

func mustJSONString(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
