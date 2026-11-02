package attachments

import "github.com/hypernewbie/phi/pkg/pty"

// panes reports the live PTY manager. main installs the provider because the
// manager is created after the routes are registered.
var panes func() *pty.Manager

// SetPaneManager installs the PTY manager provider used for paste injection.
func SetPaneManager(provider func() *pty.Manager) { panes = provider }

func paneManager() *pty.Manager {
	if panes == nil {
		return nil
	}
	return panes()
}
