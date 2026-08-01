package gitutil

import (
	"bytes"
	"context"
	"os/exec"
	"strings"

	"github.com/hypernewbie/phi/pkg/obs"
)

// IgnoredNames reports which of names are gitignored inside dir, using one
// batched `git check-ignore --stdin -z` spawn instead of a spawn per entry.
// Directory names must be passed with a trailing slash so directory-only
// patterns (`build/`) match. The returned map is keyed by the exact strings
// passed in.
//
// check-ignore exit codes: 0 = at least one path ignored (listed on stdout),
// 1 = none ignored (NOT an error), 128 = real error (e.g. not a repo).
func IgnoredNames(ctx context.Context, dir string, names []string) (map[string]bool, error) {
	ignored := map[string]bool{}
	if len(names) == 0 {
		return ignored, nil
	}
	ctx, end := obs.Span(ctx, "git.check_ignore", "cwd", dir)
	var retErr error
	defer func() { end(retErr) }()

	cmd := exec.CommandContext(ctx, "git", "check-ignore", "--stdin", "-z")
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(strings.Join(names, "\x00") + "\x00")
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
			return ignored, nil // exit 1: nothing ignored
		}
		retErr = err
		return nil, err
	}
	for _, name := range bytes.Split(out, []byte{0}) {
		if len(name) > 0 {
			ignored[string(name)] = true
		}
	}
	return ignored, nil
}
