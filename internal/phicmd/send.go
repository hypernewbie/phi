package phicmd

import (
	"context"
	"fmt"
	"strings"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

// SendEvent is one NDJSON line of a `send` stream.
type SendEvent struct {
	Type   string `json:"type"` // "session", "message_start", "message_end", "state", "turn_end", "exited", "error"
	SID    string `json:"sid,omitempty"`
	Role   string `json:"role,omitempty"`
	Text   string `json:"text,omitempty"`
	Busy   *bool  `json:"busy,omitempty"`
	Status string `json:"status,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// cmdSend resolves a chat session (spawning one when none is live),
// submits one prompt, and streams the turn's events until it completes.
func cmdSend(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("send")
	newSession := fs.Bool("new", false, "spawn a fresh session instead of reusing")
	resume := fs.String("resume", "", "spawn resuming this persisted session_path")
	noStream := fs.Bool("wait-only", false, "print only the final assistant text")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("send: %v", err)
	}
	if len(positional) < 1 {
		return usagef("send: pass the message text (quote it)")
	}
	message := strings.Join(positional, " ")
	h, err := env.connect()
	if err != nil {
		return err
	}
	c, err := DialControl(ctx, h)
	if err != nil {
		return err
	}
	defer c.Close()

	sid, spawned, err := resolveSendTarget(ctx, env, c, *newSession, *resume)
	if err != nil {
		return err
	}
	if env.JSON && !*noStream {
		_ = printNDJSON(SendEvent{Type: "session", SID: sid, Detail: boolDetail(spawned, "spawned", "reused")})
	}
	// Hydrate subscribes this connection to the session's events.
	if _, err := c.Hydrate(ctx, sid); err != nil {
		return err
	}
	if err := c.Prompt(ctx, sid, message); err != nil {
		return err
	}
	return streamTurn(ctx, env, c, sid, *noStream)
}

func boolDetail(b bool, ifTrue, ifFalse string) string {
	if b {
		return ifTrue
	}
	return ifFalse
}

// resolveSendTarget finds the session to drive: --session flag > state >
// the only live session > a fresh spawn.
func resolveSendTarget(ctx context.Context, env *Env, c *Control, forceNew bool, resume string) (string, bool, error) {
	if !forceNew && resume == "" {
		if sid := firstNonEmpty(env.Session, env.State.Session); sid != "" {
			if _, err := c.State(ctx, sid); err == nil {
				return sid, false, nil
			} else if !strings.Contains(err.Error(), "not found") && !strings.Contains(err.Error(), "unknown session") {
				return "", false, err
			}
			// A remembered sid that no longer exists falls through to
			// the live list below.
		}
		live, err := c.ListSessions(ctx)
		if err != nil {
			return "", false, err
		}
		if len(live) == 1 {
			return live[0].GetSid(), false, nil
		}
		if len(live) > 1 {
			ids := make([]string, 0, len(live))
			for _, s := range live {
				ids = append(ids, s.GetSid())
			}
			return "", false, usagef("send: %d live sessions (%s); pass --session or --new", len(live), strings.Join(ids, ", "))
		}
	}
	result, err := c.Spawn(ctx, env.resolveCwd(), resume, "")
	if err != nil {
		return "", false, err
	}
	return result.GetSid(), true, nil
}

// streamTurn consumes events until the turn ends: an assistant
// message_end plus the state going idle, or the rpc exiting.
func streamTurn(ctx context.Context, env *Env, c *Control, sid string, finalOnly bool) error {
	sawAssistant := false
	var finalText string
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("phi-cmd: turn did not finish before timeout: %w", ctx.Err())
		case <-c.Done():
			return fmt.Errorf("phi-cmd: control socket ended: %w", c.Err())
		case ev := <-c.Events():
			if ev.SID != sid {
				continue
			}
			switch e := ev.Wire().GetEvent().(type) {
			case *wspb.ControlEvent_MessageStart:
				if !finalOnly && env.JSON {
					_ = printNDJSON(SendEvent{Type: "message_start", SID: sid, Detail: "message"})
				}
			case *wspb.ControlEvent_MessageUpdate:
				// Updates are progressive; only end carries the
				// authoritative copy. Streaming every update would
				// multiply output for long turns.
			case *wspb.ControlEvent_MessageEnd:
				msg := e.MessageEnd.GetMessage()
				role := msg.GetRole()
				text := externalValueText(msg.GetContent())
				if role == "assistant" {
					sawAssistant = true
					finalText = text
				}
				if env.JSON && !finalOnly {
					_ = printNDJSON(SendEvent{Type: "message_end", SID: sid, Role: role, Text: text})
				}
			case *wspb.ControlEvent_StateChanged:
				state := e.StateChanged.GetState()
				busy := state.GetBusy()
				if env.JSON && !finalOnly {
					_ = printNDJSON(SendEvent{Type: "state", SID: sid, Busy: &busy, Status: state.GetStatus()})
				}
				if !busy && sawAssistant {
					finishSend(env, sid, finalText, finalOnly)
					return nil
				}
				if !busy && !sawAssistant {
					// The turn ended without an assistant message (for
					// example an immediate error). End honestly.
					if status := state.GetStatus(); status == "exited" {
						finishSend(env, sid, "", finalOnly)
						return nil
					}
				}
			case *wspb.ControlEvent_RpcExited:
				if env.JSON && !finalOnly {
					_ = printNDJSON(SendEvent{Type: "exited", SID: sid, Detail: e.RpcExited.GetReason()})
				}
				finishSend(env, sid, finalText, finalOnly)
				return nil
			case *wspb.ControlEvent_ExtensionError:
				if env.JSON && !finalOnly {
					_ = printNDJSON(SendEvent{Type: "error", SID: sid, Detail: e.ExtensionError.GetError()})
				}
			}
		}
	}
}

func finishSend(env *Env, sid, text string, finalOnly bool) {
	if env.JSON {
		_ = printNDJSON(SendEvent{Type: "turn_end", SID: sid, Text: text})
		return
	}
	if text != "" {
		fmt.Println(text)
	}
}
