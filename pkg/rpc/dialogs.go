package rpc

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// Retained extension UI dialogs. Pi blocks the read loop while one of these
// requests is outstanding, so the server keeps the record until it is answered
// , cancelled, or expired, and replays it on reconnect.

// retainExtensionUIDialog records one known blocking request. Duplicate IDs
// are ignored so reconnect/event duplication cannot create duplicate records.
func (i *Instance) retainExtensionUIDialog(dialog ExtensionUIDialog) bool {
	if dialog.ID == "" || !isBlockingExtensionUIMethod(dialog.Method) {
		return false
	}
	if dialog.CreatedAt == 0 {
		dialog.CreatedAt = time.Now().UnixMilli()
	}
	dialog = cloneExtensionUIDialog(dialog)
	i.dialogMu.Lock()
	defer i.dialogMu.Unlock()
	if i.dialogs == nil {
		i.dialogs = make(map[string]ExtensionUIDialog)
	}
	if _, exists := i.dialogs[dialog.ID]; exists {
		return false
	}
	i.dialogs[dialog.ID] = dialog
	if dialog.Timeout > 0 && dialog.Method != "editor" {
		if i.dialogTimers == nil {
			i.dialogTimers = make(map[string]*time.Timer)
		}
		i.dialogTimers[dialog.ID] = time.AfterFunc(time.Duration(dialog.Timeout)*time.Millisecond, func() {
			i.expireExtensionUIDialog(dialog.ID)
		})
	}
	return true
}

// ExtensionUIDialogsCopy returns retained dialogs in stable creation order.
func (i *Instance) ExtensionUIDialogsCopy() []ExtensionUIDialog {
	i.dialogMu.Lock()
	out := make([]ExtensionUIDialog, 0, len(i.dialogs))
	for _, dialog := range i.dialogs {
		out = append(out, cloneExtensionUIDialog(dialog))
	}
	i.dialogMu.Unlock()
	sort.SliceStable(out, func(left, right int) bool {
		return dialogLess(out[left], out[right])
	})
	return out
}

// dialogLess orders dialogs by creation time, then by id so equal timestamps
// stay deterministic across snapshots.
func dialogLess(left, right ExtensionUIDialog) bool {
	if left.CreatedAt == right.CreatedAt {
		return left.ID < right.ID
	}
	return left.CreatedAt < right.CreatedAt
}

func (i *Instance) takeExtensionUIDialog(id string) (ExtensionUIDialog, bool) {
	i.dialogMu.Lock()
	defer i.dialogMu.Unlock()
	dialog, ok := i.dialogs[id]
	if !ok {
		return ExtensionUIDialog{}, false
	}
	delete(i.dialogs, id)
	if timer := i.dialogTimers[id]; timer != nil {
		timer.Stop()
		delete(i.dialogTimers, id)
	}
	return cloneExtensionUIDialog(dialog), true
}

func (i *Instance) expireExtensionUIDialog(id string) {
	dialog, ok := i.takeExtensionUIDialog(id)
	if !ok {
		return
	}
	i.Emit(EvtExtensionUIClosed, nil, map[string]any{
		"id": dialog.ID, "reason": "timeout",
	})
}

// drainExtensionUIDialogs removes every retained dialog under one lock.
func (i *Instance) drainExtensionUIDialogs() []ExtensionUIDialog {
	i.dialogMu.Lock()
	closed := make([]ExtensionUIDialog, 0, len(i.dialogs))
	for _, dialog := range i.dialogs {
		closed = append(closed, cloneExtensionUIDialog(dialog))
	}
	for _, timer := range i.dialogTimers {
		timer.Stop()
	}
	i.dialogs = make(map[string]ExtensionUIDialog)
	i.dialogTimers = make(map[string]*time.Timer)
	i.dialogMu.Unlock()
	sort.SliceStable(closed, func(left, right int) bool {
		return dialogLess(closed[left], closed[right])
	})
	return closed
}

func (i *Instance) closeExtensionUIDialogs(reason string) {
	for _, dialog := range i.drainExtensionUIDialogs() {
		i.Emit(EvtExtensionUIClosed, nil, map[string]any{
			"id": dialog.ID, "reason": reason,
		})
	}
}

var ErrExtensionUIResponseInvalid = errors.New("invalid extension UI response")

func validateExtensionUIDialogResponse(dialog ExtensionUIDialog, value *string, confirmed *bool, cancelled bool) error {
	if cancelled {
		return nil
	}
	switch dialog.Method {
	case "select", "input", "editor":
		if value == nil {
			return fmt.Errorf("%w: %s requires value or cancelled", ErrExtensionUIResponseInvalid, dialog.Method)
		}
	case "confirm":
		if confirmed == nil {
			return fmt.Errorf("%w: confirm requires confirmed or cancelled", ErrExtensionUIResponseInvalid)
		}
	default:
		return fmt.Errorf("%w: unsupported dialog method %q", ErrExtensionUIResponseInvalid, dialog.Method)
	}
	return nil
}

// ResolveExtensionUIDialog removes the matching request before writing the
// answer, so concurrent and late answers are first-answer-wins. It never
// acquires the ordinary control gate.
func (i *Instance) ResolveExtensionUIDialog(id string, value *string, confirmed *bool, cancelled bool) (bool, error) {
	i.dialogMu.Lock()
	dialog, ok := i.dialogs[id]
	if !ok {
		i.dialogMu.Unlock()
		return false, nil
	}
	if err := validateExtensionUIDialogResponse(dialog, value, confirmed, cancelled); err != nil {
		i.dialogMu.Unlock()
		return false, err
	}
	delete(i.dialogs, id)
	if timer := i.dialogTimers[id]; timer != nil {
		timer.Stop()
		delete(i.dialogTimers, id)
	}
	i.dialogMu.Unlock()

	response := map[string]any{"type": "extension_ui_response", "id": id}
	if cancelled {
		response["cancelled"] = true
	} else if dialog.Method == "confirm" {
		response["confirmed"] = *confirmed
	} else {
		response["value"] = *value
	}
	if err := i.Send(response); err != nil {
		return true, err
	}
	return true, nil
}

// CancelExtensionUIDialogs resolves all open requests as cancelled while the
// child is alive and emits one close event per removed record.
func (i *Instance) CancelExtensionUIDialogs(reason string) int {
	closed := i.drainExtensionUIDialogs()
	for _, dialog := range closed {
		if i.IsAlive() {
			_ = i.Send(map[string]any{
				"type": "extension_ui_response", "id": dialog.ID, "cancelled": true,
			})
		}
		i.Emit(EvtExtensionUIClosed, nil, map[string]any{
			"id": dialog.ID, "reason": reason,
		})
	}
	return len(closed)
}

// cancelUnsupportedExtensionUI prevents an unknown blocking request from
// leaving Pi waiting forever. It emits the same close event used by later
// dialog cancellation paths; Send is guarded by the instance's alive state.
func (i *Instance) cancelUnsupportedExtensionUI(id string) {
	if id == "" {
		return
	}
	_ = i.Send(map[string]any{
		"type":      "extension_ui_response",
		"id":        id,
		"cancelled": true,
	})
	i.Emit(EvtExtensionUIClosed, nil, map[string]any{
		"id": id, "reason": "unsupported",
	})
}
