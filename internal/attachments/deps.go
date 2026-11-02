package attachments

import (
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
)

// API binds attachment routes to one store and live pane registry.
// Constructing it does not open a store or start services.
type API struct {
	Store                    *AttachmentStore
	panes                    func() *pty.Manager
	attachmentPutReadTimeout time.Duration
}

func NewAPI(panes func() *pty.Manager) *API {
	return &API{panes: panes, attachmentPutReadTimeout: 10 * time.Minute}
}

func (a *API) paneManager() *pty.Manager {
	if a.panes == nil {
		return nil
	}
	return a.panes()
}
