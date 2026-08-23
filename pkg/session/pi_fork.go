package session

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// GetPiForkSessionRPCTranscript reads a nested fork session file under
// the Pi sessions root, enforcing the shared reader's safety checks
// without the top-level listing gate (fork sessions live in
// subdirectories the listing never sees).
func GetPiForkSessionRPCTranscript(cwd, sessionPath string) ([]PiRPCMessage, error) {
	if !filepath.IsAbs(sessionPath) {
		return nil, fmt.Errorf("Pi fork session path must be absolute: %s", sessionPath)
	}
	root := expandHome("~/.pi/agent/sessions")
	if !strings.HasPrefix(sessionPath, root+string(os.PathSeparator)) {
		return nil, fmt.Errorf("Pi fork session path %q escapes the sessions root", sessionPath)
	}
	payloads, err := readPiSessionRawMessages(cwd, sessionPath)
	if err != nil {
		return nil, err
	}
	return formatPiRPCMessages(payloads)
}
