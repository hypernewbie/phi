package phicmd

import (
	"flag"
	"fmt"
	"io"
	"strings"
)

// newSubflags builds a per-command flag set that fails quietly; the
// caller wraps the parse error as a usage error.
func newSubflags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parseSubArgs splits args into flags and positionals without stopping
// at the first positional, then parses the flags. A flag the command
// defines belongs to the command; any other flag falls back to the
// global definitions bound to env (mutating env), so
// `send "hi" --json --session s1` works. "--" ends flag gathering.
func parseSubArgs(fs *flag.FlagSet, env *Env, args []string) ([]string, error) {
	valueFlags := map[string]bool{}
	known := map[string]bool{}
	fs.VisitAll(func(f *flag.Flag) {
		known["-"+f.Name] = true
		known["--"+f.Name] = true
		if f.DefValue != "true" && f.DefValue != "false" {
			valueFlags["-"+f.Name] = true
			valueFlags["--"+f.Name] = true
		}
	})
	globalValues := map[string]bool{}
	if env != nil && env.globalFS != nil {
		env.globalFS.VisitAll(func(f *flag.Flag) {
			if f.DefValue != "true" && f.DefValue != "false" {
				globalValues["-"+f.Name] = true
				globalValues["--"+f.Name] = true
			}
		})
	}
	flags := []string{}
	globals := []string{}
	positional := []string{}
	for i := 0; i < len(args); i++ {
		tok := args[i]
		if tok == "--" {
			positional = append(positional, args[i+1:]...)
			return finishSubParse(fs, env, flags, globals, positional)
		}
		if len(tok) > 1 && tok[0] == '-' && !isNegativeNumber(tok) {
			name := tok
			if eq := strings.Index(tok, "="); eq > 0 {
				name = tok[:eq]
			}
			target := &flags
			needsValue := valueFlags[name]
			if !known[name] {
				target = &globals
				needsValue = globalValues[name]
			}
			*target = append(*target, tok)
			if needsValue && !strings.Contains(tok, "=") && i+1 < len(args) {
				i++
				*target = append(*target, args[i])
			}
			continue
		}
		positional = append(positional, tok)
	}
	return finishSubParse(fs, env, flags, globals, positional)
}

func finishSubParse(fs *flag.FlagSet, env *Env, flags, globalFlags, positional []string) ([]string, error) {
	if err := fs.Parse(flags); err != nil {
		return nil, err
	}
	if len(globalFlags) > 0 {
		if env == nil || env.globalFS == nil {
			return nil, fmt.Errorf("unknown flag %q", globalFlags[0])
		}
		if err := env.globalFS.Parse(globalFlags); err != nil {
			return nil, err
		}
	}
	return positional, nil
}

func isNegativeNumber(tok string) bool {
	rest := tok[1:]
	if rest == "" {
		return false
	}
	for _, r := range rest {
		if (r < '0' || r > '9') && r != '.' {
			return false
		}
	}
	return true
}
