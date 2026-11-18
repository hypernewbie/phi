// Command phi-cmd drives Phi backends from the command line: list the
// configured servers, inspect live sessions, send prompts and raw pane
// input, switch models, and read diffs. One process per command; exit
// codes are a contract for scripts and agents.
//
// It links no terminal emulation (unlike phic) and changes nothing on
// the server: every capability is an existing Phi API or WebSocket.
package main

import (
	"os"

	"github.com/hypernewbie/phi/internal/phicmd"
)

// Version and Commit are set by the release build (-X main.Version,
// -X main.Commit). The names are exported so the linker can reach them.
var (
	Version = "dev"
	Commit  = "unreleased"
)

func main() {
	phicmd.SetVersion(Version, Commit)
	os.Exit(phicmd.Run(os.Args[1:]))
}
