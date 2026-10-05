// Command phic is a minimal native terminal client for Phi.
package main

import (
	"fmt"
	"os"

	"github.com/hypernewbie/phi/internal/phic"
)

func main() {
	if err := phic.Run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "phic:", err)
		os.Exit(1)
	}
}
