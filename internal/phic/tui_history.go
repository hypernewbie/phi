package phic

import "github.com/hypernewbie/phi/internal/termemu"

// The history command uses only the parser's local 10,000-row buffer.
// It cannot rewind the archive or construct a parser from a missing prefix.
type paneHistoryView struct{ Browsing bool }

func (p *paneActor) requestHistory() {
	alt, _ := p.emu.Mode(termemu.ModeAlternateScreen)
	if alt {
		return
	}
	p.mu.Lock()
	historyRows := p.frame.History
	p.mu.Unlock()
	if scroller, ok := p.emu.(interface{ ScrollViewport(int) error }); ok {
		if err := scroller.ScrollViewport(-historyRows); err != nil {
			p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: err.Error()})
			return
		}
		p.historyOffset = -historyRows
		p.dirty = true
	}
}
func (p *paneActor) returnLive() {
	if p.historyOffset == 0 {
		return
	}
	if scroller, ok := p.emu.(interface{ ScrollViewport(int) error }); ok {
		if err := scroller.ScrollViewport(1 << 30); err != nil {
			p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: err.Error()})
		}
	}
	p.historyOffset = 0
	p.dirty = true
}
