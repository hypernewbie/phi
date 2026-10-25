package rpc

import "github.com/hypernewbie/phi/pkg/session"

// titleSources holds the per-instance title inputs. Guarded by Instance.titleMu.
type titleSources struct {
	nativeName  string // latest accepted native name; empty means none
	promptTitle string // first useful user request
	seeded      bool   // a native source already established authority
}

// resolve returns the displayed title: native name, then request fallback,
// then the generic phi label.
func (s titleSources) resolve(cwd string) string {
	if s.nativeName != "" {
		return s.nativeName
	}
	if s.promptTitle != "" {
		return s.promptTitle
	}
	return TitleFor(cwd, "")
}

// seedPromptTitle returns the fallback carried by the first useful user
// request in message order.
func seedPromptTitle(msgs []Message) string {
	for _, msg := range msgs {
		if msg.Role != "user" {
			continue
		}
		if title := session.PiPromptTitle(msg.Content); title != "" {
			return title
		}
	}
	return ""
}

// TitleFor returns the phi-owned title: supplied, or prefix+basename(cwd).
func TitleFor(cwd, supplied string) string {
	if supplied != "" {
		return supplied
	}
	return DefaultTitlePrefix + basename(cwd)
}

func basename(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[i+1:]
		}
	}
	return path
}
