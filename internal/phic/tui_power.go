package phic

import "time"

const (
	// 30fps is ample for terminal interaction; watching continuous output
	// drops to 10fps after 30 seconds without input. These pace presentation,
	// not byte ingestion or keyboard delivery.
	paneInteractiveInterval = time.Second / 30
	paneWatchingInterval    = time.Second / 10
	paneWatchingAfter       = 30 * time.Second
)

func panePaintInterval(now, interaction time.Time) time.Duration {
	if now.Sub(interaction) >= paneWatchingAfter {
		return paneWatchingInterval
	}
	return paneInteractiveInterval
}

func (p *paneActor) noteInteraction(now time.Time) {
	p.mu.Lock()
	p.lastInteraction = now
	p.mu.Unlock()
}
