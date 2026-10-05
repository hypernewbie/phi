// Command phic is a minimal native terminal client for Phi.
package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/hypernewbie/phi/internal/phic"
)

var (
	Version = "dev"
	Commit  = "unreleased"
	Date    = ""
)

func main() {
	if err := phic.RunWithVersion(os.Args[1:], fmt.Sprintf("phic %s (commit: %s, built: %s)", Version, Commit, Date)); err != nil {
		fmt.Fprintln(os.Stderr, "phic:", phic.QuotedID(err.Error()))
		var exit *phic.ExitError
		if errors.As(err, &exit) {
			os.Exit(exit.Code)
		}
		os.Exit(1)
	}
}
