package session

import (
	"github.com/hypernewbie/phi/pkg/coders"
	"regexp"
	"strings"
)

var resumeNoticeANSI = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var codexResumeNotice = regexp.MustCompile(`(?m)^\s*To continue this session, run:\s*\n\s*codex resume ([0-9a-fA-F-]{36})\s*$`)
var agyResumeNotice = regexp.MustCompile(`(?mi)^\s*(?:conversation(?: id)?|session(?: id)?)\s*:\s*([0-9a-f-]{36})\s*$`)
var openCodeResumeNotice = regexp.MustCompile(`(?m)^\s*opencode (?:--session|-s) (ses_[A-Za-z0-9_-]+)\s*$`)

// Observe native CLI resume notices without another process, state file, or
// "most recent" session guess. Keep only a bounded tail across split reads.
func ResumeReferenceObserver(c coders.Coder, bind func(string)) func([]byte) {
	var pattern *regexp.Regexp
	switch c.ID {
	case "codex":
		pattern = codexResumeNotice
	case "agy":
		pattern = agyResumeNotice
	case "opencode":
		pattern = openCodeResumeNotice
	default:
		return nil
	}
	tail := ""
	return func(data []byte) {
		tail += string(data)
		if len(tail) > 8192 {
			tail = tail[len(tail)-8192:]
		}
		plain := resumeNoticeANSI.ReplaceAllString(tail, "")
		plain = strings.ReplaceAll(plain, "\r", "")
		matches := pattern.FindAllStringSubmatch(plain, -1)
		if len(matches) > 0 {
			bind(matches[len(matches)-1][1])
			tail = ""
		}
	}
}
