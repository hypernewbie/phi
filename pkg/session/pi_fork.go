package session

import (
	"fmt"
	"path/filepath"
	"strings"
)

func isSubpath(parent, target string) bool {
	parent = filepath.Clean(parent)
	target = filepath.Clean(target)
	rel, err := filepath.Rel(parent, target)
	if err != nil {
		return false
	}
	return !strings.HasPrefix(rel, "..") && rel != "." && !filepath.IsAbs(rel)
}

// GetPiForkSessionRPCTranscript reads a nested fork session file under
// the Pi sessions root, enforcing the shared reader's safety checks
// without the top-level listing gate (fork sessions live in
// subdirectories the listing never sees).
func GetPiForkSessionRPCTranscript(cwd, sessionPath string) ([]PiRPCMessage, error) {
	if !filepath.IsAbs(sessionPath) {
		return nil, fmt.Errorf("Pi fork session path must be absolute: %s", sessionPath)
	}
	root := expandHome("~/.pi/agent/sessions")
	if !isSubpath(root, sessionPath) {
		return nil, fmt.Errorf("Pi fork session path %q escapes the sessions root", sessionPath)
	}
	payloads, err := readPiSessionRawMessages(cwd, sessionPath)
	if err != nil {
		return nil, err
	}
	return formatPiRPCMessages(payloads)
}
