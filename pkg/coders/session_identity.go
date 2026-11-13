package coders

import "github.com/google/uuid"

// FreshSession gives backends that support caller-selected identities an
// exact native resume reference from their first launch. Never use --last.
// Codex and Agy report their own native resume references. Psi chooses its
// own ID and reports it through its built-in bridge; forcing a fresh ID
// would make it scan the session store before startup.
func FreshSession(c Coder) (Coder, string) {
	flag := ""
	switch {
	case c.ID == "claude" && c.SessionSource == "claude_files":
		flag = "--session-id"
	case c.ID == "pi" && c.SessionSource == "pi_files" && c.PiMode != "psi":
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
