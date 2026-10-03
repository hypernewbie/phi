package coders

import "github.com/google/uuid"

// FreshSession gives backends that support caller-selected identities an
// exact native resume reference from their first launch. Never use --last.
// Codex and Agy choose their own IDs; their native resume notices are observed
// instead, and an unavailable reference safely becomes a fresh conversation.
func FreshSession(c Coder) (Coder, string) {
	flag := ""
	switch {
	case c.ID == "claude" && c.SessionSource == "claude_files":
		flag = "--session-id"
	case c.ID == "pi" && c.SessionSource == "pi_files":
		flag = "--session-id"
	case c.ID == "opencode" && c.SessionSource == "opencode_v2":
		flag = "--session"
	default:
		return c, ""
	}
	id := uuid.NewString()
	if c.ID == "opencode" {
		id = "ses_" + id
	}
	out := frozenCoder(c)
	out.Args = append(out.Args, flag, id)
	return out, id
}
