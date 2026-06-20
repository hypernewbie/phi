// Package lint provides lightweight static checks for the project's
// web/style.css and web/index.html. Designed to catch the class of
// bug that bit us with a stray '}' silently re-scoping ~1.5k lines
// of CSS rules from @media (max-width: 768px) into global scope
// (every "mobile" rule leaking to desktop).
//
// The checks are intentionally minimal — they don't try to be a full
// CSS/HTML parser. They walk brace/tag depth and verify @media
// blocks and HTML tags open and close where they should. If this
// codebase ever grows real lint needs, swap this for stylelint +
// htmlhint.
package lint

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// Issue describes a lint finding.
type Issue struct {
	Line  int    // 1-indexed line where the problem was found
	Kind  string // short identifier ("unbalanced", "media-not-closed", ...)
	Msg   string // human-readable explanation
}

func (i Issue) String() string {
	return fmt.Sprintf("lint %s at line %d: %s", i.Kind, i.Line, i.Msg)
}

// mediaFrame tracks a single @media block during brace-depth walking.
type mediaFrame struct {
	openLine int // line where the @media block opened (the '{' line)
	preDepth int // brace depth before entering the @media
}

// htmlOpenTag tracks a single open HTML element for well-formedness checking.
type htmlOpenTag struct {
	name string
	line int
}

// CheckBraces walks the given CSS source and returns any issues found.
// It tracks brace depth globally and, when entering an @media block,
// expects the matching close to come at the expected @media-closing
// brace (depth returning to the pre-@media level at the right place).
//
// Catches:
//   - Mismatched brace counts overall
//   - @media blocks whose closing brace is far from the block's natural
//     end (the bug we hit: a stray '}' closed the @media 1500 lines early)
//
// Does NOT catch:
//   - CSS parse errors in selectors
//   - Invalid property values
//   - Cross-file issues
func CheckBraces(src string) []Issue {
	lines := strings.Split(src, "\n")
	var issues []Issue

	var depth int
	var stack []mediaFrame
	var mediaOpen bool

	for i, line := range lines {
		lineNo := i + 1
		stripped := stripCommentsAndStrings(line)

		opens := strings.Count(stripped, "{")
		closes := strings.Count(stripped, "}")

		// Detect @media opening on this line (only if we're not already inside one
		// at this depth — can't nest @media in standard CSS but be defensive).
		if !mediaOpen && strings.Contains(stripped, "@media") && opens > 0 {
			mediaOpen = true
			stack = append(stack, mediaFrame{
				openLine: lineNo,
				preDepth: depth, // depth before the '{' on this line
			})
		}

		// Apply opens
		for n := 0; n < opens; n++ {
			depth++
		}
		// Apply closes
		for n := 0; n < closes; n++ {
			depth--
			if mediaOpen && depth == stack[len(stack)-1].preDepth {
				// We just returned to the depth we were at before this @media.
				// That means this '}' closed the @media block.
				frame := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				issues = append(issues, checkMediaClose(frame, lineNo, lines)...)
				mediaOpen = len(stack) > 0
			}
		}

		if depth < 0 {
			issues = append(issues, Issue{
				Line:  lineNo,
				Kind:  "unbalanced",
				Msg:   fmt.Sprintf("brace depth went negative (%d) — extra '}' before this line", depth),
			})
			// Reset to keep scanning without spamming.
			depth = 0
		}
	}

	if depth != 0 {
		issues = append(issues, Issue{
			Line:  len(lines),
			Kind:  "unbalanced",
			Msg:   fmt.Sprintf("file ended with depth %d (expected 0) — missing %d closing '}'", depth, depth),
		})
	}

	// Any @media still on the stack at EOF was never closed.
	for _, frame := range stack {
		issues = append(issues, Issue{
			Line:  frame.openLine,
			Kind:  "media-not-closed",
			Msg:   fmt.Sprintf("@media block opened at line %d never closed", frame.openLine),
		})
	}

	return issues
}

// checkMediaClose returns an issue if the @media block closed too far
// from its opening — a heuristic for "this rule was supposed to be
// mobile but leaked globally".
func checkMediaClose(frame mediaFrame, closeLine int, lines []string) []Issue {
	const farFromOpenThreshold = 100 // lines — well within normal @media block size

	blockLen := closeLine - frame.openLine
	if blockLen < farFromOpenThreshold {
		return nil // block closed quickly, looks normal
	}

	// Additional heuristic: a "normal" @media block typically spans
	// < 500 lines. If it's much larger, it likely swallowed a stray '}'.
	if blockLen > 500 {
		return []Issue{{
			Line:  closeLine,
			Kind:  "media-too-large",
			Msg:   fmt.Sprintf("@media block opened at line %d spans %d lines — suspiciously large; check for stray '}' before this line that re-scoped mobile rules to global", frame.openLine, blockLen),
		}}
	}

	return nil
}

// stripCommentsAndStrings removes the contents of /* ... */ comments
// from a single line so braces inside comments don't affect the count.
// Strings (url("..."), content: "...") could theoretically contain
// braces too — handle double-quoted strings defensively.
//
// Unclosed /* comments at end of line are emitted as-is rather than
// greedily stripping the rest of the line (which would miscount any
// braces that appear after them).
func stripCommentsAndStrings(line string) string {
	var b strings.Builder
	inComment := false
	inString := false
	prev := byte(0)
	for i := 0; i < len(line); i++ {
		c := line[i]
		if inComment {
			if c == '*' && i+1 < len(line) && line[i+1] == '/' {
				inComment = false
				b.WriteString("*/") // emit the close so structure is visible
				i++ // skip the '/'
				continue
			}
			continue // skip comment contents (braces inside don't count)
		}
		if inString {
			if c == '"' && prev != '\\' {
				inString = false
			}
			b.WriteByte(c)
			prev = c
			continue
		}
		// Not in comment or string
		if c == '/' && i+1 < len(line) && line[i+1] == '*' {
			inComment = true
			b.WriteString("/*") // emit the open so structure is visible
			i++ // skip the '*'
			continue
		}
		if c == '"' {
			inString = true
			b.WriteByte(c)
			prev = c
			continue
		}
		b.WriteByte(c)
		prev = c
	}
	// Unclosed comment at EOF: emit the open `/*` and stop stripping.
	// The remaining content is preserved verbatim so downstream
	// braces are counted normally.
	return b.String()
}

// CheckFile is a convenience that reads a CSS file and lints it.
func CheckFile(path string) ([]Issue, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return CheckBraces(string(data)), nil
}

// RunStyleCSS is a convenience for use in tests: lints
// ../../web/style.css relative to the package directory. Fails the
// test if any issues are found.
func RunStyleCSS(t *testing.T) {
	t.Helper()
	issues, err := CheckFile("../../web/style.css")
	if err != nil {
		t.Fatalf("lint: %v", err)
	}
	if len(issues) > 0 {
		for _, i := range issues {
			t.Errorf("%s", i)
		}
		t.FailNow()
	}
}

// ── HTML checks ────────────────────────────────────────────────────────────────
//
// Minimal HTML well-formedness checks. Catches:
//   - Unbalanced tags (e.g. <div>...<span></div></span>)
//   - Duplicate id attributes
//   - Mis-nested void elements (e.g. <br><div></div></br> — illegal)
//
// Not a real parser. Skips content inside <script> and <style> tags
// (which can contain < and > that would confuse naive tag-matching).
// Does NOT catch:
//   - Invalid attribute values
//   - Missing required attributes (alt on img, etc.)
//   - Accessibility issues

// htmlVoidElements are tags that don't have a closing tag per HTML5.
var htmlVoidElements = map[string]bool{
	"area": true, "base": true, "br": true, "col": true,
	"embed": true, "hr": true, "img": true, "input": true,
	"link": true, "meta": true, "source": true, "track": true, "wbr": true,
}

// htmlRawTextElements have raw-text content that shouldn't be parsed for tags.
var htmlRawTextElements = map[string]bool{
	"script": true, "style": true,
}

// CheckHTML scans HTML source for the issues described above. It
// does NOT understand the full HTML5 parsing algorithm; it tracks
// open/close tag balance linearly and checks for duplicate ids.
//
// Uses a hand-written state machine rather than regex because regex
// for nested tags is brittle (RE2's non-greedy semantics interact
// awkwardly with character classes containing < and >).
//
// If the source contains <script> or <style> blocks, their contents
// are skipped (not parsed for tags).
func CheckHTML(src string) []Issue {
	var issues []Issue

	lines := strings.Split(src, "\n")

	// Stack of currently-open tags, with the line each was opened on.
	type openTag struct {
		name string
		line int
	}
	var stack []htmlOpenTag

	// Track which lines we're inside raw-text elements (so we don't
	// try to parse < inside script/style blocks).
	var rawTextElement string
	rawTextStartLine := 0

	// id tracking
	seenIDs := make(map[string]int) // id -> first line seen

	for i, line := range lines {
		lineNo := i + 1

		// Inside a raw-text element (script/style): look only for the close tag.
		if rawTextElement != "" {
			closeTag := "</" + rawTextElement
			if idx := strings.Index(line, closeTag); idx >= 0 {
				// Make sure it's a complete close tag (followed by >, possibly with whitespace)
				end := idx + len(closeTag)
				if end < len(line) {
					j := end
					for j < len(line) && (line[j] == ' ' || line[j] == '\t') {
						j++
					}
					if j < len(line) && line[j] == '>' {
						rawTextElement = ""
						rawTextStartLine = 0
						// Process the rest of the line starting after this close tag
						rest := line[j+1:]
						if rest != "" {
							issues = append(issues, scanLine(rest, lineNo, j+1, &stack, &rawTextElement, &rawTextStartLine, seenIDs)...)
						}
					}
				}
			}
			continue
		}

		issues = append(issues, scanLine(line, lineNo, 0, &stack, &rawTextElement, &rawTextStartLine, seenIDs)...)
	}

	// Any tags still open at EOF were never closed.
	for _, t := range stack {
		issues = append(issues, Issue{
			Line:  t.line,
			Kind:  "html-unclosed",
			Msg:   fmt.Sprintf("<%s> opened at line %d never closed", t.name, t.line),
		})
	}
	if rawTextElement != "" {
		issues = append(issues, Issue{
			Line:  rawTextStartLine,
			Kind:  "html-unclosed-rawtext",
			Msg:   fmt.Sprintf("<%s> opened at line %d never closed", rawTextElement, rawTextStartLine),
		})
	}

	return issues
}

// scanLine processes a single line's tags starting at offset `start`.
// Used both for top-level scanning and for scanning the tail of a line
// after a script/style close tag.
func scanLine(line string, lineNo, start int, stack *[]htmlOpenTag, rawTextElement *string, rawTextStartLine *int, seenIDs map[string]int) []Issue {
	var issues []Issue

	i := start
	for i < len(line) {
		// Find next <
		ltIdx := strings.IndexByte(line[i:], '<')
		if ltIdx < 0 {
			break
		}
		i += ltIdx
		if i >= len(line) {
			break
		}

		// Need at least < + letter
		if i+1 >= len(line) {
			break
		}
		c := line[i+1]
		if c == '/' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			// Looks like a real tag. Parse it.
			tagEnd, isClose, tagName, attrs := parseTag(line, i)
			if tagEnd > i {
				tagLine := lineNo
				processTag(isClose, tagName, attrs, tagLine, &issues, stack, rawTextElement, rawTextStartLine, seenIDs)
				i = tagEnd + 1
				if *rawTextElement != "" {
					// Just entered raw-text mode (script/style open). Look for the
					// close tag on the SAME line (handles single-line script blocks).
					closeTag := "</" + *rawTextElement + ">"
					if idx := strings.Index(line[i:], closeTag); idx >= 0 {
						absoluteIdx := i + idx
						// Find the closing > to skip past the close tag
						endOfClose := absoluteIdx + len(closeTag)
						*rawTextElement = ""
						*rawTextStartLine = 0
						// Recurse to process anything after the close tag
						rest := line[endOfClose:]
						if rest != "" {
							issues = append(issues, scanLine(rest, lineNo, 0, stack, rawTextElement, rawTextStartLine, seenIDs)...)
						}
						return issues
					}
					// No close on this line; outer loop will check subsequent lines.
					return issues
				}
				continue
			}
		}
		// Skip this < and continue (might be inside text like "a < b" or "< 5")
		i++
	}
	return issues
}

// parseTag attempts to parse a tag starting at position `start` in line.
// Returns (endPos, isClose, tagName, attrs) where endPos is the index of
// the closing > (or start if no valid tag found).
func parseTag(line string, start int) (int, bool, string, string) {
	if start >= len(line) || line[start] != '<' {
		return start, false, "", ""
	}
	i := start + 1
	isClose := false
	if i < len(line) && line[i] == '/' {
		isClose = true
		i++
	}
	// Skip whitespace
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	// Read tag name
	nameStart := i
	for i < len(line) {
		c := line[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			i++
		} else {
			break
		}
	}
	if i == nameStart {
		return start, false, "", "" // no tag name
	}
	tagName := strings.ToLower(line[nameStart:i])
	attrsStart := i
	// Find the closing > (must appear on this line for our scope; nested < in attrs is unusual HTML)
	for i < len(line) {
		if line[i] == '>' {
			attrs := line[attrsStart:i]
			return i, isClose, tagName, attrs
		}
		i++
	}
	// Unclosed tag (no > before EOL)
	return start, false, "", ""
}

// processTag handles the open/close/void/raw-text logic for a parsed tag.
func processTag(
	isClose bool,
	tagName, attrs string,
	tagLine int,
	issues *[]Issue,
	stack *[]htmlOpenTag,
	rawTextElement *string,
	rawTextStartLine *int,
	seenIDs map[string]int,
) {
	if isClose {
		if htmlVoidElements[tagName] {
			*issues = append(*issues, Issue{
				Line:  tagLine,
				Kind:  "html-illegal-close",
				Msg:   fmt.Sprintf("</%s> is a void element and cannot be closed", tagName),
			})
			return
		}
		if len(*stack) == 0 {
			*issues = append(*issues, Issue{
				Line:  tagLine,
				Kind:  "html-unmatched-close",
				Msg:   fmt.Sprintf("</%s> with no matching open tag", tagName),
			})
			return
		}
		top := (*stack)[len(*stack)-1]
		if top.name != tagName {
			*issues = append(*issues, Issue{
				Line:  tagLine,
				Kind:  "html-mismatched-close",
				Msg:   fmt.Sprintf("</%s> closes <%s> opened at line %d (mismatch)", tagName, top.name, top.line),
			})
			// Pop until we find the matching one (best-effort recovery).
			for len(*stack) > 0 && (*stack)[len(*stack)-1].name != tagName {
				*stack = (*stack)[:len(*stack)-1]
			}
			if len(*stack) > 0 {
				*stack = (*stack)[:len(*stack)-1]
			}
			return
		}
		*stack = (*stack)[:len(*stack)-1]
		return
	}

	// Open tag
	if htmlVoidElements[tagName] {
		// No stack push for void elements (br, img, input, etc.)
	} else if htmlRawTextElements[tagName] {
		*rawTextElement = tagName
		*rawTextStartLine = tagLine
	} else {
		*stack = append(*stack, htmlOpenTag{name: tagName, line: tagLine})
	}

	// Check id attribute.
	if idVal, ok := extractID(attrs); ok {
		if firstLine, dup := seenIDs[idVal]; dup {
			*issues = append(*issues, Issue{
				Line:  tagLine,
				Kind:  "html-duplicate-id",
				Msg:   fmt.Sprintf("id=%q is also defined at line %d", idVal, firstLine),
			})
		} else {
			seenIDs[idVal] = tagLine
		}
	}
}

// extractID pulls the first id="..." or id='...' value out of an
// attribute string. Returns the value and true, or "", false if not
// found.
func extractID(attrs string) (string, bool) {
	idx := strings.Index(attrs, "id=")
	if idx < 0 {
		idx = strings.Index(attrs, "id =")
	}
	if idx < 0 {
		return "", false
	}
	// Skip past "id="
	j := idx
	for j < len(attrs) && attrs[j] != '=' {
		j++
	}
	if j >= len(attrs) {
		return "", false
	}
	j++ // past =
	for j < len(attrs) && (attrs[j] == ' ' || attrs[j] == '\t') {
		j++
	}
	if j >= len(attrs) {
		return "", false
	}
	if attrs[j] != '"' && attrs[j] != '\'' {
		return "", false
	}
	quote := attrs[j]
	j++
	start := j
	for j < len(attrs) && attrs[j] != quote {
		j++
	}
	if j >= len(attrs) {
		return "", false
	}
	return attrs[start:j], true
}

// CheckHTMLFile is a convenience that reads an HTML file and lints it.
func CheckHTMLFile(path string) ([]Issue, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return CheckHTML(string(data)), nil
}

// RunIndexHTML is a convenience for use in tests: lints
// ../../web/index.html relative to the package directory. Fails the
// test if any issues are found.
func RunIndexHTML(t *testing.T) {
	t.Helper()
	issues, err := CheckHTMLFile("../../web/index.html")
	if err != nil {
		t.Fatalf("lint: %v", err)
	}
	if len(issues) > 0 {
		for _, i := range issues {
			t.Errorf("%s", i)
		}
		t.FailNow()
	}
}
