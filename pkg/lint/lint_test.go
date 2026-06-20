package lint

import (
	"strings"
	"testing"
)

func TestCheckBraces_Balanced(t *testing.T) {
	src := `
body { color: red; }
.brand { display: flex; }
@media (max-width: 768px) {
    .x { font-size: 12px; }
}
`
	issues := CheckBraces(src)
	if len(issues) != 0 {
		t.Errorf("expected no issues for balanced CSS, got: %v", issues)
	}
}

func TestCheckBraces_UnbalancedMissing(t *testing.T) {
	src := `
body { color: red;
.brand { display: flex; }
`
	issues := CheckBraces(src)
	if len(issues) == 0 {
		t.Fatal("expected issue for unbalanced CSS, got none")
	}
	if issues[0].Kind != "unbalanced" {
		t.Errorf("expected kind=unbalanced, got %q", issues[0].Kind)
	}
}

func TestCheckBraces_ExtraClose(t *testing.T) {
	src := `
body { color: red; }
}
.brand { display: flex; }
`
	issues := CheckBraces(src)
	if len(issues) == 0 {
		t.Fatal("expected issue for extra '}', got none")
	}
	found := false
	for _, i := range issues {
		if i.Kind == "unbalanced" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected unbalanced issue, got: %v", issues)
	}
}

// TestCheckBraces_StrayCloseInMedia is the actual regression test
// for the bug the user hit: a stray '}' inside an @media block
// silently closes the block ~1.5k lines early, causing everything
// after it to leak to global scope.
//
// Construct a CSS file where an extra '}' inside an @media block
// causes the depth-walk to detect the imbalance and surface it.
func TestCheckBraces_StrayCloseInMedia(t *testing.T) {
	// Stray '}' after the first inner close means depth goes
	// negative at that line.
	src := `
.a { color: red; }
@media (max-width: 768px) {
    .b { font-size: 12px; }
}
}
.c { padding: 4px; }
`
	issues := CheckBraces(src)
	found := false
	for _, i := range issues {
		if i.Kind == "unbalanced" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected unbalanced issue for stray '}' in @media, got: %v", issues)
	}
}

func TestCheckBraces_MediaTooLarge(t *testing.T) {
	// Construct a file where @media closes after >500 lines.
	// This is the heuristic that would have caught the user's bug.
	var b strings.Builder
	b.WriteString(".init { color: red; }\n")
	b.WriteString("@media (max-width: 768px) {\n")
	for i := 0; i < 600; i++ {
		b.WriteString("    .x" + strings.Repeat("x", i%20) + " { padding: 4px; }\n")
	}
	b.WriteString("}\n")
	src := b.String()
	issues := CheckBraces(src)
	found := false
	for _, i := range issues {
		if i.Kind == "media-too-large" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected media-too-large issue for 600+ line @media block, got: %v", issues)
	}
}

func TestStripCommentsAndStrings(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		// Inside comments is stripped; the /* and */ markers are kept
		// as structural sentinels (no braces to affect depth either way).
		{`/* comment */ body { color: red; }`, `/**/ body { color: red; }`},
		// String contents preserved verbatim (would contain braces).
		{`url("http://example.com/{")`, `url("http://example.com/{")`},
		// Unclosed comment at EOF: preserve the open marker and stop,
		// don't greedily strip the rest of the file's braces.
		{`/* unclosed comment`, `/*`},
		{`body { color: red; } /* trailing */`, `body { color: red; } /**/`},
	}
	for _, c := range cases {
		got := stripCommentsAndStrings(c.in)
		if got != c.want {
			t.Errorf("stripCommentsAndStrings(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestRunStyleCSS lints the actual project style.css. This is the
// integration test that would have caught the stray '}' bug before
// it shipped.
//
// It uses RunStyleCSS helper which t.FailNow()s on any issue.
//
// We run it conditionally: if the file path is wrong (e.g. test
// running from a different directory), skip rather than fail so the
// package is portable.
func TestRunStyleCSS(t *testing.T) {
	issues, err := CheckFile("../../web/style.css")
	if err != nil {
		t.Skipf("could not find web/style.css (running from %s); skipping integration test", err)
		return
	}
	if len(issues) > 0 {
		for _, i := range issues {
			t.Errorf("%s", i)
		}
		t.FailNow()
	}
}

// ── HTML lint tests ─────────────────────────────────────────────────────────────

func TestCheckHTML_Balanced(t *testing.T) {
	src := `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<div class="x">
  <span>hello</span>
</div>
</body>
</html>
`
	issues := CheckHTML(src)
	if len(issues) != 0 {
		t.Errorf("expected no issues for balanced HTML, got: %v", issues)
	}
}

func TestCheckHTML_UnclosedTag(t *testing.T) {
	src := `<div><span>hello</div></span>
`
	issues := CheckHTML(src)
	found := false
	for _, i := range issues {
		if i.Kind == "html-unclosed" || i.Kind == "html-mismatched-close" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected unclosed/mismatched issue, got: %v", issues)
	}
}

func TestCheckHTML_VoidElement(t *testing.T) {
	// Void elements like <br> should not need closing tags.
	src := `<p>line one<br>line two</p>
`
	issues := CheckHTML(src)
	if len(issues) != 0 {
		t.Errorf("void element should not trigger issues, got: %v", issues)
	}
}

func TestCheckHTML_IllegalVoidClose(t *testing.T) {
	// </br> is illegal — void elements have no closing tag.
	src := `<p>line one<br>line two</br></p>
`
	issues := CheckHTML(src)
	found := false
	for _, i := range issues {
		if i.Kind == "html-illegal-close" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected html-illegal-close for </br>, got: %v", issues)
	}
}

func TestCheckHTML_DuplicateID(t *testing.T) {
	src := `<div id="foo">a</div>
<div id="bar">b</div>
<div id="foo">c</div>
`
	issues := CheckHTML(src)
	found := false
	for _, i := range issues {
		if i.Kind == "html-duplicate-id" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected duplicate-id issue, got: %v", issues)
	}
}

func TestCheckHTML_ScriptContentsIgnored(t *testing.T) {
	// < inside a script block should NOT be parsed as a tag open.
	src := `<html><body>
<script>if (a < b) { foo(); }</script>
</body></html>
`
	issues := CheckHTML(src)
	if len(issues) != 0 {
		t.Errorf("script contents with < should be ignored, got: %v", issues)
	}
}

func TestCheckHTML_UnmatchedClose(t *testing.T) {
	src := `</div>
`
	issues := CheckHTML(src)
	found := false
	for _, i := range issues {
		if i.Kind == "html-unmatched-close" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected html-unmatched-close, got: %v", issues)
	}
}

func TestRunIndexHTML(t *testing.T) {
	issues, err := CheckHTMLFile("../../web/index.html")
	if err != nil {
		t.Skipf("could not find web/index.html (running from %s); skipping integration test", err)
		return
	}
	if len(issues) > 0 {
		for _, i := range issues {
			t.Errorf("%s", i)
		}
		t.FailNow()
	}
}
