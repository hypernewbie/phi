// Command testserver is the M1 Go ↔ TypeScript interop harness. It owns one
// local IPC endpoint and bridge Server, then executes JSON control ops from
// stdin and reports JSON results on stdout. Request IDs cross the control
// surface as decimal strings to preserve uint64 range. Never log tokens.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/hypernewbie/phi/internal/pibridge"
)

type request struct {
	Op      string `json:"op"`
	Pane    string `json:"pane"`
	Process string `json:"process"`
	Count   int    `json:"count"`
}

type response struct {
	OK           bool     `json:"ok"`
	Error        string   `json:"error,omitempty"`
	Code         int      `json:"code,omitempty"`
	Process      string   `json:"process,omitempty"`
	Token        string   `json:"token,omitempty"`
	Sent         int      `json:"sent,omitempty"`
	Active       int      `json:"active,omitempty"`
	Leases       int      `json:"leases,omitempty"`
	HasPeer      bool     `json:"hasPeer,omitempty"`
	HasState     bool     `json:"hasState,omitempty"`
	State        int32    `json:"state,omitempty"`
	Revision     string   `json:"revision,omitempty"`
	JournalFirst string   `json:"journalFirst,omitempty"`
	JournalLast  string   `json:"journalLast,omitempty"`
	JournalGap   bool     `json:"journalGap,omitempty"`
	Generation   string   `json:"generation,omitempty"`
	RuntimeID    string   `json:"runtimeId,omitempty"`
	Caps         []string `json:"caps,omitempty"`
	Session      string   `json:"session,omitempty"`
	Leaf         string   `json:"leaf,omitempty"`
	Model        string   `json:"model,omitempty"`
}

func fail(format string, args ...any) response {
	return response{OK: false, Error: fmt.Sprintf(format, args...)}
}

func main() {
	if err := run(); err != nil {
		enc := json.NewEncoder(os.Stdout)
		_ = enc.Encode(fail("%v", err))
		os.Exit(1)
	}
}

func run() error {
	ep, err := pibridge.NewEndpoint()
	if err != nil {
		return err
	}
	lis, err := ep.Listen()
	if err != nil {
		ep.Cleanup()
		return err
	}
	srv := pibridge.NewServer()
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.GRPCServer().Serve(lis) }()

	enc := json.NewEncoder(os.Stdout)
	// Ready line first; integration asserts the target shape.
	if err := enc.Encode(map[string]any{"ready": true, "target": ep.Target}); err != nil {
		return err
	}

	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 64*1024), 64*1024)
	for scan.Scan() {
		line := scan.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			_ = enc.Encode(fail("bad control json: %v", err))
			continue
		}
		switch req.Op {
		case "register":
			proc, token, err := srv.RegisterPending(req.Pane)
			if err != nil {
				_ = enc.Encode(fail("%v", err))
				continue
			}
			_ = enc.Encode(response{OK: true, Process: proc, Token: token})
		case "complete":
			srv.Complete(req.Process)
			_ = enc.Encode(response{OK: true})
		case "revoke":
			srv.Revoke(req.Process)
			_ = enc.Encode(response{OK: true})
		case "flood":
			sent := srv.FloodForTest(req.Process, req.Count)
			_ = enc.Encode(response{OK: true, Sent: sent})
		case "stats":
			active, leases := srv.Stats()
			_ = enc.Encode(response{OK: true, Active: active, Leases: leases})
		case "inspect":
			view, found := srv.InspectForTest(req.Process)
			if !found {
				_ = enc.Encode(fail("unknown process"))
				continue
			}
			_ = enc.Encode(response{
				OK: true, HasPeer: view.HasPeer, HasState: view.HasState,
				State: int32(view.State), Revision: strconv.FormatUint(view.Revision, 10),
				JournalFirst: strconv.FormatUint(view.JournalFirst, 10),
				JournalLast:  strconv.FormatUint(view.JournalLast, 10),
				JournalGap:   view.JournalGap,
				Generation:   strconv.FormatUint(view.Generation, 10), RuntimeID: view.RuntimeID,
				Caps: view.Caps, Session: view.SessionID, Leaf: view.LeafID, Model: view.Model,
			})
		case "shutdown":
			_ = enc.Encode(response{OK: true})
			srv.Stop()
			_ = lis.Close()
			ep.Cleanup()
			return nil
		default:
			_ = enc.Encode(fail("unknown op %q", req.Op))
		}
	}
	if err := scan.Err(); err != nil {
		srv.Stop()
		_ = lis.Close()
		ep.Cleanup()
		return err
	}
	srv.Stop()
	_ = lis.Close()
	ep.Cleanup()
	return nil
}
