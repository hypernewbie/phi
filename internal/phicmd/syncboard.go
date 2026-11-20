package phicmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// SyncEntry mirrors the server's SyncMessage: a board key, its string
// value, and both timestamps. The server normalizes every posted value
// to a string (a JSON string stays text, an object stays its raw JSON),
// so a get always decodes into this shape.
type SyncEntry struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

const (
	syncNotifMarker = "PHI_NOTIF"
	syncAlarmMarker = "PHI_ALARM"
)

// cmdSyncboard is the shared-board helper: list/get/post/notify/alarm/
// delete/wait over /api/sync/messages. Same auth, same bounds, no new
// server surface. `wait` blocks until a board condition holds so agents
// can sleep instead of spinning.
func cmdSyncboard(ctx context.Context, env *Env, args []string) error {
	if len(args) < 1 {
		return usagef("syncboard: pass a subcommand: list | get | post | notify | alarm | delete | wait")
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "list":
		return cmdSyncboardList(ctx, env, rest)
	case "get":
		return cmdSyncboardGet(ctx, env, rest)
	case "post":
		return cmdSyncboardPost(ctx, env, rest, "")
	case "notify":
		return cmdSyncboardPost(ctx, env, rest, syncNotifMarker)
	case "alarm":
		return cmdSyncboardPost(ctx, env, rest, syncAlarmMarker)
	case "delete", "rm":
		return cmdSyncboardDelete(ctx, env, rest)
	case "wait":
		return cmdSyncboardWait(ctx, env, rest)
	default:
		return usagef("syncboard: unknown subcommand %q (list | get | post | notify | alarm | delete | wait)", sub)
	}
}

func syncboardConnect(env *Env) (*HTTP, error) {
	// Every subcommand targets one backend, so even `wait` reports a
	// refused login as auth instead of hanging until the deadline.
	return env.connect()
}

func cmdSyncboardList(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("syncboard list")
	prefix := fs.String("prefix", "", "only keys starting with this prefix")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("syncboard list: %v", err)
	}
	if len(positional) > 0 {
		return usagef("syncboard list: takes no keys (pass one to `get`)")
	}
	h, err := syncboardConnect(env)
	if err != nil {
		return err
	}
	var entries []SyncEntry
	if err := h.Do(ctx, "GET", "/api/sync/messages", nil, &entries); err != nil {
		return err
	}
	if *prefix != "" {
		kept := entries[:0]
		for _, e := range entries {
			if strings.HasPrefix(e.Key, *prefix) {
				kept = append(kept, e)
			}
		}
		entries = kept
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Key < entries[j].Key })
	if env.JSON {
		return printJSON(map[string]any{"messages": entries})
	}
	if len(entries) == 0 {
		fmt.Println("no sync messages")
		return nil
	}
	t := newTable("key", "updated")
	for _, e := range entries {
		t.row(e.Key, e.UpdatedAt)
	}
	t.flush()
	return nil
}

func cmdSyncboardGet(ctx context.Context, env *Env, args []string) error {
	positional, err := parseSubArgs(newSubflags("syncboard get"), env, args)
	if err != nil {
		return usagef("syncboard get: %v", err)
	}
	if len(positional) < 1 {
		return usagef("syncboard get: pass the key")
	}
	key := positional[0]
	h, err := syncboardConnect(env)
	if err != nil {
		return err
	}
	entry, found, err := syncGet(ctx, h, key)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("%w: no sync message %q", ErrNotFound, key)
	}
	if env.JSON {
		return printJSON(entry)
	}
	fmt.Println(entry.Value)
	return nil
}

// syncGet fetches one key: found=false on the server's 404, so callers
// can tell "absent" from a transport failure.
func syncGet(ctx context.Context, h *HTTP, key string) (SyncEntry, bool, error) {
	var entry SyncEntry
	err := h.Do(ctx, "GET", "/api/sync/messages/"+url.PathEscape(key), nil, &entry)
	if err != nil {
		var api *APIError
		if errors.As(err, &api) && api.Status == 404 {
			return SyncEntry{}, false, nil
		}
		return SyncEntry{}, false, err
	}
	return entry, true, nil
}

func cmdSyncboardPost(ctx context.Context, env *Env, args []string, marker string) error {
	name := "syncboard post"
	if marker == syncNotifMarker {
		name = "syncboard notify"
	} else if marker == syncAlarmMarker {
		name = "syncboard alarm"
	}
	fs := newSubflags(name)
	asJSON := fs.Bool("as-json", false, "send VALUE as raw JSON instead of a string")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("%s: %v", name, err)
	}
	if len(positional) < 2 {
		return usagef("%s: pass KEY and VALUE (quote them)", name)
	}
	key := positional[0]
	if marker != "" {
		key += " " + marker
	}
	value := strings.Join(positional[1:], " ")
	var raw json.RawMessage
	if *asJSON {
		if !json.Valid([]byte(value)) {
			return usagef("%s: --as-json value is not valid JSON", name)
		}
		raw = json.RawMessage(value)
	} else {
		raw, _ = json.Marshal(value)
	}
	h, err := syncboardConnect(env)
	if err != nil {
		return err
	}
	entry, err := syncPost(ctx, h, key, raw)
	if err != nil {
		return err
	}
	if env.JSON {
		return printJSON(entry)
	}
	fmt.Printf("upserted %s\n", entry.Key)
	return nil
}

func syncPost(ctx context.Context, h *HTTP, key string, value json.RawMessage) (SyncEntry, error) {
	payload, _ := json.Marshal(map[string]any{"key": key, "value": value})
	var entry SyncEntry
	if err := h.Do(ctx, "POST", "/api/sync/messages", payload, &entry); err != nil {
		return SyncEntry{}, err
	}
	return entry, nil
}

func cmdSyncboardDelete(ctx context.Context, env *Env, args []string) error {
	positional, err := parseSubArgs(newSubflags("syncboard delete"), env, args)
	if err != nil {
		return usagef("syncboard delete: %v", err)
	}
	if len(positional) < 1 {
		return usagef("syncboard delete: pass the key")
	}
	key := positional[0]
	h, err := syncboardConnect(env)
	if err != nil {
		return err
	}
	_, status, err := h.Raw(ctx, "DELETE", "/api/sync/messages/"+url.PathEscape(key), nil)
	if err != nil && status == 0 {
		return err
	}
	deleted := true
	if status == 404 {
		// Deleting an absent key is success with deleted=false: scripts
		// must not fail on an already-clean board. (The skill doc claims
		// the server 200s here; it actually 404s, so phi-cmd absorbs it.)
		deleted = false
	} else if err != nil {
		return err
	}
	if env.JSON {
		return printJSON(map[string]any{"key": key, "deleted": deleted})
	}
	if deleted {
		fmt.Printf("deleted %s\n", key)
	} else {
		fmt.Printf("no such key %s (nothing to do)\n", key)
	}
	return nil
}

// syncWaitResult is one satisfied `wait`: the entry plus how long it took.
type syncWaitResult struct {
	SyncEntry
	WaitedMs int64 `json:"waited_ms"`
}

func cmdSyncboardWait(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("syncboard wait")
	mode := fs.String("for", "present", "condition: present | absent | change | match")
	match := fs.String("match", "", "with --for match: regexp the value must satisfy")
	from := fs.String("from", "", "with --for change: baseline updated_at (default: first read)")
	poll := fs.Duration("poll", time.Second, "how often to re-read the board")
	alarmOnly := fs.Bool("alarm-only", false, "wake on any PHI_ALARM entry (no KEY)")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("syncboard wait: %v", err)
	}
	if *poll <= 0 {
		return usagef("syncboard wait: --poll must be positive")
	}
	var key string
	if *alarmOnly {
		if len(positional) > 0 {
			return usagef("syncboard wait: --alarm-only takes no KEY")
		}
	} else {
		if len(positional) < 1 {
			return usagef("syncboard wait: pass the KEY (or --alarm-only)")
		}
		key = positional[0]
	}
	var re *regexp.Regexp
	if *mode == "match" {
		if *match == "" {
			return usagef("syncboard wait: --for match needs --match REGEXP")
		}
		var err error
		if re, err = regexp.Compile(*match); err != nil {
			return usagef("syncboard wait: bad --match: %v", err)
		}
	} else if *match != "" {
		return usagef("syncboard wait: --match only applies to --for match")
	}
	switch *mode {
	case "present", "absent", "change", "match":
	default:
		return usagef("syncboard wait: --for must be present | absent | change | match")
	}
	h, err := syncboardConnect(env)
	if err != nil {
		return err
	}
	// --timeout after the command name parses too late for Run's
	// deadline (the context is built from the pre-command flags only).
	// Honor a shorter value here so `wait ... --timeout 30s` does what
	// it says; a longer value still needs pre-command placement, which
	// is what builds the parent context that caps this one.
	if d, ok := ctx.Deadline(); ok && env.Globals.Timeout > 0 && time.Until(d) > env.Globals.Timeout {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, env.Globals.Timeout)
		defer cancel()
	}
	start := time.Now()
	base := &syncBaseline{}
	check := func() (SyncEntry, bool, error) {
		if *alarmOnly {
			return syncPollAlarm(ctx, h)
		}
		return syncPollKey(ctx, h, key, *mode, re, *from, base)
	}
	if entry, done, err := check(); err != nil {
		return err
	} else if done {
		return finishSyncWait(env, entry, time.Since(start))
	}
	ticker := time.NewTicker(*poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			entry, done, err := check()
			if err != nil {
				return err
			}
			if done {
				return finishSyncWait(env, entry, time.Since(start))
			}
		}
	}
}

// syncBaseline remembers the first read of a --for change wait so the
// next read can report movement. One struct per wait: no shared state,
// so in-process tests can run concurrent waits on the same key.
type syncBaseline struct {
	seen      bool
	updatedAt string
	value     string
}

// syncPollKey evaluates one KEY condition against the baseline.
func syncPollKey(ctx context.Context, h *HTTP, key, mode string, re *regexp.Regexp, from string, base *syncBaseline) (SyncEntry, bool, error) {
	entry, found, err := syncGet(ctx, h, key)
	if err != nil {
		return SyncEntry{}, false, err
	}
	switch mode {
	case "present":
		return entry, found, nil
	case "absent":
		return entry, !found, nil
	case "change":
		if !found {
			return entry, false, nil
		}
		if from != "" {
			return entry, entry.UpdatedAt != from, nil
		}
		if base.seen {
			return entry, entry.UpdatedAt != base.updatedAt || entry.Value != base.value, nil
		}
		*base = syncBaseline{seen: true, updatedAt: entry.UpdatedAt, value: entry.Value}
		return entry, false, nil
	case "match":
		return entry, found && re.MatchString(entry.Value), nil
	}
	return SyncEntry{}, false, nil
}

// syncPollAlarm scans the whole board for the first PHI_ALARM entry,
// sorted by key so concurrent alarms wake deterministically.
func syncPollAlarm(ctx context.Context, h *HTTP) (SyncEntry, bool, error) {
	var entries []SyncEntry
	if err := h.Do(ctx, "GET", "/api/sync/messages", nil, &entries); err != nil {
		return SyncEntry{}, false, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Key < entries[j].Key })
	for _, e := range entries {
		if strings.Contains(e.Key, syncAlarmMarker) || strings.Contains(e.Value, syncAlarmMarker) {
			return e, true, nil
		}
	}
	return SyncEntry{}, false, nil
}

func finishSyncWait(env *Env, entry SyncEntry, waited time.Duration) error {
	result := syncWaitResult{SyncEntry: entry, WaitedMs: waited.Milliseconds()}
	if env.JSON {
		return printJSON(result)
	}
	fmt.Println(entry.Value)
	return nil
}
