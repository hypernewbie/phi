package phicmd

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Recipe bounds mirror the server's validation (pkg/coders) and the
// browser executor (web-src/coders.ts): 8 steps, 256 bytes each, 5 s
// total delay. The model identifier may not carry control characters.
const (
	maxRecipeSteps     = 8
	maxRecipeStepBytes = 256
	maxRecipeTotalMs   = 5000
)

type recipeStep struct {
	Send    string `json:"send"`
	DelayMs int    `json:"delay_ms,omitempty"`
}

// inputSender is the pane write the recipe steps become.
type inputSender func(data []byte) error

// runRecipe executes a coder's model_switch recipe against one pane,
// with the browser executor's exact semantics: validate up front,
// substitute {model} literally (no replacement metacharacters), abort on
// the first failed send, never replay, and respect per-step delays.
func runRecipe(ctx context.Context, steps []recipeStep, model string, send inputSender) error {
	if len(steps) == 0 {
		return fmt.Errorf("phi-cmd: model switch recipe has no steps")
	}
	if len(steps) > maxRecipeSteps {
		return fmt.Errorf("phi-cmd: recipe exceeds %d steps", maxRecipeSteps)
	}
	if hasControlChar(model) {
		return fmt.Errorf("phi-cmd: model identifier contains control characters")
	}
	total := 0
	for i, step := range steps {
		if step.Send == "" {
			return fmt.Errorf("phi-cmd: recipe step %d is empty", i)
		}
		if len(step.Send) > maxRecipeStepBytes {
			return fmt.Errorf("phi-cmd: recipe step %d exceeds %d bytes", i, maxRecipeStepBytes)
		}
		if step.DelayMs < 0 {
			return fmt.Errorf("phi-cmd: recipe step %d has a negative delay", i)
		}
		total += step.DelayMs
	}
	if total > maxRecipeTotalMs {
		return fmt.Errorf("phi-cmd: recipe total delay %dms exceeds %dms", total, maxRecipeTotalMs)
	}
	for i, step := range steps {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Literal substitution: "$&" in a model name must stay "$&".
		payload := strings.ReplaceAll(step.Send, "{model}", model)
		if err := send([]byte(payload)); err != nil {
			return fmt.Errorf("phi-cmd: recipe step %d send failed (aborting, not replaying): %w", i, err)
		}
		if step.DelayMs > 0 && i < len(steps)-1 {
			select {
			case <-time.After(time.Duration(step.DelayMs) * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return nil
}

func hasControlChar(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
