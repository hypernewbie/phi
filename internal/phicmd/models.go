package phicmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

// cmdModels shows what can drive a model switch for the target: a live
// chat session's models/thinking levels, or a coder's presets/recipe.
func cmdModels(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("models")
	if _, err := parseSubArgs(fs, env, args); err != nil {
		return usagef("models: %v", err)
	}
	h, err := env.connect()
	if err != nil {
		return err
	}

	// Live chat session path: full model + thinking lists.
	if sid := firstNonEmpty(env.Session, env.State.Session); sid != "" {
		c, err := DialControl(ctx, h)
		if err != nil {
			return err
		}
		defer c.Close()
		if _, err := c.State(ctx, sid); err == nil {
			models, err := c.Models(ctx, sid)
			if err != nil {
				return err
			}
			levels, err := c.ThinkingLevels(ctx, sid)
			if err != nil {
				return err
			}
			state, _ := c.State(ctx, sid)
			out := map[string]any{
				"session":         sid,
				"models":          modelInfos(models),
				"thinking_levels": levels,
			}
			if state != nil {
				out["current_model"] = state.GetModel()
				out["current_thinking"] = state.GetThinking()
			}
			if env.JSON {
				return printJSON(out)
			}
			for _, m := range modelInfos(models) {
				mark := ""
				if state != nil && state.GetModel() != "" && m.Model == state.GetModel() {
					mark = "  (current)"
				}
				fmt.Printf("%s/%s%s\n", m.Provider, m.Model, mark)
			}
			fmt.Printf("thinking: %s\\n", strings.Join(levels, ", "))
			return nil
		}
	}

	// Coder path: presets and the declarative recipe.
	coder := env.resolveCoder()
	coders, err := fetchCoders(ctx, h)
	if err != nil {
		return err
	}
	for _, cd := range coders {
		if cd.ID != coder {
			continue
		}
		out := map[string]any{
			"coder":                 cd.ID,
			"model_switch_disabled": cd.ModelSwitchDisabled,
			"presets":               cd.Presets,
			"recipe":                cd.ModelSwitch,
		}
		if env.JSON {
			return printJSON(out)
		}
		for _, p := range cd.Presets {
			fmt.Printf("preset %s = %s\n", p.Name, p.Value)
		}
		if len(cd.ModelSwitch) > 0 {
			fmt.Printf("recipe (%d steps):\n", len(cd.ModelSwitch))
			for _, s := range cd.ModelSwitch {
				fmt.Printf("  send %q delay=%dms\n", s.Send, s.DelayMs)
			}
		} else {
			fmt.Printf("recipe: (none)\n")
		}
		return nil
	}
	return fmt.Errorf("%w: no coder %q", ErrNotFound, coder)
}

type modelInfo struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

func modelInfos(models []*wspb.ModelInfo) []modelInfo {
	out := make([]modelInfo, 0, len(models))
	for _, m := range models {
		out = append(out, modelInfo{Provider: m.GetProvider(), Model: m.GetId()})
	}
	return out
}

// cmdModelSet switches the model by the backend's own mechanism:
// control set_model for a live chat session, the Pi bridge for a pi
// pane, or the coder's recipe typed into a pane.
func cmdModelSet(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("model set")
	paneFlag := fs.String("pane", "", "pane id for recipe/pi-bridge switches")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("model set: %v", err)
	}
	if len(positional) != 1 {
		return usagef("model set: pass one model as PROVIDER/MODEL (chat sessions) or MODEL (recipes)")
	}
	spec := positional[0]
	h, err := env.connect()
	if err != nil {
		return err
	}

	// 1. Live chat session.
	if sid := firstNonEmpty(env.Session, env.State.Session); sid != "" {
		c, err := DialControl(ctx, h)
		if err != nil {
			return err
		}
		defer c.Close()
		if _, err := c.State(ctx, sid); err == nil {
			provider, modelID, ok := splitModelSpec(spec)
			if !ok {
				return usagef("model set: chat sessions need PROVIDER/MODEL")
			}
			state, err := c.SetModel(ctx, sid, provider, modelID)
			if err != nil {
				return err
			}
			if env.JSON {
				return printJSON(map[string]any{"session": sid, "model": state.GetModel()})
			}
			fmt.Printf("session %s model: %s\n", sid, state.GetModel())
			return nil
		}
	}

	// 2. Pi pane via the bridge HTTP API.
	pane, err := resolvePane(ctx, env, h, *paneFlag)
	if err != nil {
		return err
	}
	if pane != "" && paneLooksPi(ctx, env, h, pane) {
		provider, modelID, ok := splitModelSpec(spec)
		if !ok {
			return usagef("model set: the pi bridge needs PROVIDER/MODEL")
		}
		body, _ := json.Marshal(map[string]string{"pane": pane, "provider": provider, "model": modelID})
		var ack struct {
			OK     bool   `json:"ok"`
			Reason string `json:"reason"`
		}
		if err := h.Do(ctx, "POST", "/api/pi-bridge/model", body, &ack); err != nil {
			return err
		}
		if !ack.OK {
			return fmt.Errorf("phi-cmd: pi bridge refused: %s", ack.Reason)
		}
		if env.JSON {
			return printJSON(map[string]any{"pane": pane, "provider": provider, "model": modelID})
		}
		fmt.Printf("pane %s model: %s/%s\n", pane, provider, modelID)
		return nil
	}

	// 3. Coder recipe typed into the pane.
	coder := env.resolveCoder()
	coders, err := fetchCoders(ctx, h)
	if err != nil {
		return err
	}
	for _, cd := range coders {
		if cd.ID != coder {
			continue
		}
		if cd.ModelSwitchDisabled {
			return fmt.Errorf("phi-cmd: coder %q disables model switching", coder)
		}
		if len(cd.ModelSwitch) == 0 {
			// No fallback /model guess: the browser's rule.
			return fmt.Errorf("phi-cmd: coder %q has no model switch recipe; nothing to drive", coder)
		}
		if pane == "" {
			return usagef("model set: recipe switch needs --pane (see `phi-cmd tabs`)")
		}
		p, err := AttachPane(ctx, h, pane)
		if err != nil {
			return err
		}
		defer p.Close()
		// Consume the attach frame before typing.
		select {
		case <-p.Frames():
		case <-ctx.Done():
			return ctx.Err()
		}
		if err := runRecipe(ctx, cd.ModelSwitch, spec, p.SendInput); err != nil {
			return err
		}
		if env.JSON {
			return printJSON(map[string]any{"pane": pane, "model": spec, "mechanism": "recipe"})
		}
		fmt.Printf("pane %s: recipe sent for %s\n", pane, spec)
		return nil
	}
	return fmt.Errorf("%w: no coder %q", ErrNotFound, coder)
}

func splitModelSpec(spec string) (provider, model string, ok bool) {
	i := strings.Index(spec, "/")
	if i <= 0 || i == len(spec)-1 {
		return "", "", false
	}
	return spec[:i], spec[i+1:], true
}

// resolvePane picks a pane: flag > the only live pane.
func resolvePane(ctx context.Context, env *Env, h *HTTP, flag string) (string, error) {
	if flag != "" {
		return flag, nil
	}
	var terminals []terminalSnapshot
	if err := h.Do(ctx, "GET", "/api/terminals", nil, &terminals); err != nil {
		return "", err
	}
	if len(terminals) == 1 {
		return terminals[0].ID, nil
	}
	if len(terminals) == 0 {
		return "", nil
	}
	return "", usagef("model set: %d live panes; pass --pane (see `phi-cmd tabs`)", len(terminals))
}

// paneLooksPi reports whether the pane runs a pi coder, for the bridge
// model switch path.
func paneLooksPi(_ context.Context, env *Env, h *HTTP, pane string) bool {
	var terminals []terminalSnapshot
	if err := h.Do(context.Background(), "GET", "/api/terminals", nil, &terminals); err != nil {
		return false
	}
	for _, t := range terminals {
		if t.ID == pane {
			return t.Coder == "pi" || t.Coder == "psi" || t.Coder == "pi-mini"
		}
	}
	return false
}
