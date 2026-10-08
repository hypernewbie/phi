//go:build windows

package pty

func (p *Pty) resizeAndRefresh(cols, rows uint16) error {
	// ConPTY owns window-size notifications. Always invoke its native resize
	// operation, including equal-size refresh requests; never fake a grid size.
	return p.pt.Resize(int(cols), int(rows))
}
