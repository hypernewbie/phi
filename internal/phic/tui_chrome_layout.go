package phic

import "github.com/charmbracelet/x/ansi"

// Rendered cell spans are the authority for chrome clicks. Screen fractions,
// byte offsets and guessed label widths disagree with compact/CJK layouts.
type chromeHit struct {
	start, end int
	action     string
}
type chromeLine struct {
	text string
	hits []chromeHit
}

func (line *chromeLine) append(text, action string) {
	start := ansi.StringWidth(line.text)
	line.text += text
	if action != "" {
		line.hits = append(line.hits, chromeHit{start: start, end: start + ansi.StringWidth(text), action: action})
	}
}
func (line chromeLine) hit(x, width int) string {
	if x < 0 || x >= width {
		return ""
	}
	for _, hit := range line.hits {
		if x >= hit.start && x < hit.end {
			return hit.action
		}
	}
	return ""
}
