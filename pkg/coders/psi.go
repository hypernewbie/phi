package coders

import (
	"fmt"
)

// PiPsi selects Psi for one launch of the Pi profile without modifying
// the registry's default command or session source.
func PiPsi(c Coder) (Coder, error) {
	if c.ID != "pi" || c.SessionSource != "pi_files" {
		return Coder{}, fmt.Errorf("Psi requires the Pi backend")
	}
	out := frozenCoder(c)
	cmd := "psi"
	if out.PsiCommand != "" {
		cmd = out.PsiCommand
	}
	out.Command = cmd
	out.PiMode = "psi"
	return out, nil
}
