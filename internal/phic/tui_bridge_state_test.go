package phic

import (
	"strings"
	"testing"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

// bareBridgeActor builds one actor whose only job is frame observation.
func bareBridgeActor(t *testing.T, origin, pane string, events chan paneEvent) *paneActor {
	t.Helper()
	return &paneActor{
		ctx:    t.Context(),
		spec:   paneSpec{Key: paneKey{Origin: origin, ID: pane}},
		events: events,
	}
}

func bridgeStateFrame(t *testing.T, mut ...func(*wspb.TerminalBridgeState)) []byte {
	t.Helper()
	bs := &wspb.TerminalBridgeState{
		PaneId:            proto.String("p"),
		State:             proto.String("ready"),
		Generation:        proto.Uint64(5),
		TelemetryRevision: proto.Uint64(11),
		RunId:             proto.Uint64(3),
		ContextRevision:   proto.Uint64(9),
		ProcessId:         proto.String("pi-42"),
		Model:             proto.String("claude-sonnet-4-5"),
		ThinkingLevel:     proto.String("high"),
		ContextPercent:    proto.Float64(42.5),
		Connected:         proto.Bool(true),
	}
	for _, fn := range mut {
		fn(bs)
	}
	frame, err := wireproto.EncodeBridgeStateFrame(bs)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

// TestPaneBridgeStateFrameProducesSnapshotEvents pins the actor-side
// decode: one event per changed snapshot, none for repeats or misroutes.
func TestPaneBridgeStateFrameProducesSnapshotEvents(t *testing.T) {
	events := make(chan paneEvent, 8)
	p := bareBridgeActor(t, "http://test", "p", events)

	if err := p.handleFrame(bridgeStateFrame(t)); err != nil {
		t.Fatal(err)
	}
	ev := <-events
	if ev.Kind != paneBridge {
		t.Fatalf("event kind = %d, want paneBridge", ev.Kind)
	}
	snap := ev.Bridge
	if snap.model != "claude-sonnet-4-5" || snap.thinkingLevel != "high" || !snap.connected ||
		snap.generation != 5 || snap.telemetryRevision != 11 || snap.processID != "pi-42" ||
		snap.runID != 3 || snap.contextRevision != 9 || snap.contextPercent != 42.5 {
		t.Fatalf("snapshot decode: %+v", snap)
	}
	if !snap.hasOrigin() {
		t.Fatal("snapshot origin stamps were lost")
	}

	// Identical push: deduped, no second event.
	if err := p.handleFrame(bridgeStateFrame(t)); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-events:
		t.Fatalf("duplicate snapshot produced event: %+v", ev)
	default:
	}

	// Changed generation: one new event.
	changed := bridgeStateFrame(t, func(bs *wspb.TerminalBridgeState) { bs.Generation = proto.Uint64(6) })
	if err := p.handleFrame(changed); err != nil {
		t.Fatal(err)
	}
	if ev := <-events; ev.Bridge.generation != 6 {
		t.Fatalf("changed generation not forwarded: %+v", ev.Bridge)
	}

	// Misrouted pane id: ignored, no event.
	other := bridgeStateFrame(t, func(bs *wspb.TerminalBridgeState) { bs.PaneId = proto.String("other"); bs.Generation = proto.Uint64(7) })
	if err := p.handleFrame(other); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-events:
		t.Fatalf("misrouted bridge state produced event: %+v", ev.Bridge)
	default:
	}
}

// TestPaneBridgeSettlementUpdatesSnapshot pins run-outcome recording.
func TestPaneBridgeSettlementUpdatesSnapshot(t *testing.T) {
	events := make(chan paneEvent, 8)
	p := bareBridgeActor(t, "http://test", "p", events)
	if err := p.handleFrame(bridgeStateFrame(t)); err != nil {
		t.Fatal(err)
	}
	<-events

	frame, err := wireproto.EncodeSettlementFrame("p", 5, 3, "completed")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.handleFrame(frame); err != nil {
		t.Fatal(err)
	}
	ev := <-events
	if ev.Bridge.lastOutcome != "completed" || ev.Bridge.generation != 5 {
		t.Fatalf("settlement not recorded on snapshot: %+v", ev.Bridge)
	}

	// Misrouted settlement: ignored.
	frame, err = wireproto.EncodeSettlementFrame("other", 5, 4, "failed")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.handleFrame(frame); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-events:
		t.Fatalf("misrouted settlement produced event: %+v", ev.Bridge)
	default:
	}
}

// TestPaneBridgeInvalidContextPercentIsDropped pins that an out-of-range
// context fill is clamped, never rendered as a lie.
func TestPaneBridgeInvalidContextPercentIsDropped(t *testing.T) {
	events := make(chan paneEvent, 8)
	p := bareBridgeActor(t, "http://test", "p", events)
	frame := bridgeStateFrame(t, func(bs *wspb.TerminalBridgeState) { bs.ContextPercent = proto.Float64(250) })
	if err := p.handleFrame(frame); err != nil {
		t.Fatal(err)
	}
	ev := <-events
	if ev.Bridge.contextPercent != 0 {
		t.Fatalf("out-of-range context percent = %v, want 0", ev.Bridge.contextPercent)
	}
}

// TestTabBridgeLabelAndFooterSegment pins the chrome surface: the tab label
// segment and the footer line the model renders from one snapshot.
func TestTabBridgeLabelAndFooterSegment(t *testing.T) {
	events := make(chan paneEvent, 8)
	m := newTUIModel("test", config{}, nil, []*serverState{{
		profile: desktopProfile{ID: "s1", Name: "fake", Origin: "http://fake:7070"},
		api:     mustAPI(t, "http://fake:7070"),
	}}, 0, stubBuild)
	m.width, m.height = 100, 30
	m.cliApplied = true
	m.data[m.currentOrigin()] = &serverData{loaded: true, coders: []CoderDescriptor{{ID: "pi", Name: "Pi"}}}
	p := bareBridgeActor(t, m.currentOrigin(), "p", events)
	tab := m.ensureTab(m.currentOrigin(), "p", spawnCapture{origin: m.currentOrigin(), index: 0, project: "/work", coder: "pi"})
	tab.actor = p
	m.activateTab(m.currentOrigin(), tab)

	if err := p.handleFrame(bridgeStateFrame(t)); err != nil {
		t.Fatal(err)
	}
	ev := waitPaneEvent(t, events, paneBridge)
	m.handlePaneEvent(ev)
	if tab.bridge == nil {
		t.Fatal("model did not store the bridge snapshot")
	}
	label := tab.bridgeLabel()
	if !strings.Contains(label, "claude-sonnet-4-5") || !strings.Contains(label, "high") || !strings.Contains(label, "ctx 42%") {
		t.Fatalf("bridge label = %q", label)
	}
	footer := m.renderFooter()
	if !strings.Contains(footer, "claude-sonnet-4-5") {
		t.Fatalf("footer lost the bridge segment: %q", footer)
	}

	// A disconnected bridge shows its state word instead of model details.
	disconnected := bridgeStateFrame(t, func(bs *wspb.TerminalBridgeState) {
		bs.Connected = proto.Bool(false)
		bs.State = proto.String("reconnecting")
	})
	if err := p.handleFrame(disconnected); err != nil {
		t.Fatal(err)
	}
	ev = waitPaneEvent(t, events, paneBridge)
	m.handlePaneEvent(ev)
	if label := tab.bridgeLabel(); !strings.Contains(label, "pi bridge: reconnecting") {
		t.Fatalf("disconnected label = %q", label)
	}
}
