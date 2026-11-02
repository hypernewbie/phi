package attachments

import "github.com/hypernewbie/phi/pkg/pty"

// ptyManager is the pane registry the handlers resolve, and panes lets the
// test fixture replace it without touching process globals.
var ptyManager *pty.Manager

func init() {
	panes = func() *pty.Manager { return ptyManager }
}
