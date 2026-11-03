package syncmesh

import "testing"

// TestRecentReturnsNewestLast proves the browser list order and the bound.
func TestRecentReturnsNewestLast(t *testing.T) {
	h := NewHub()
	for _, id := range []string{"m-1", "m-2", "m-3"} {
		if _, _, err := h.Publish(id, "agent-a", "agent-b", []byte(id), 0); err != nil {
			t.Fatalf("publish %s: %v", id, err)
		}
	}

	got := h.Recent(2)
	if len(got) != 2 {
		t.Fatalf("got %d messages, want 2", len(got))
	}
	if got[0].GetMessageId() != "m-2" || got[1].GetMessageId() != "m-3" {
		t.Fatalf("order = %s,%s, want m-2,m-3", got[0].GetMessageId(), got[1].GetMessageId())
	}
}

// TestRecentCopiesValues protects the store: a caller mutating what it read
// must not corrupt a later delivery.
func TestRecentCopiesValues(t *testing.T) {
	h := NewHub()
	if _, _, err := h.Publish("m-1", "a", "b", []byte("original"), 0); err != nil {
		t.Fatalf("publish: %v", err)
	}

	got := h.Recent(1)[0]
	for i := range got.Value {
		got.Value[i] = 'x'
	}

	again := h.Recent(1)[0]
	if string(again.GetValue()) != "original" {
		t.Fatalf("stored value = %q, want it unchanged", again.GetValue())
	}
}

// TestRecentHonoursLimit guards against an unbounded response.
func TestRecentHonoursLimit(t *testing.T) {
	h := NewHub()
	for i := 0; i < 5; i++ {
		if _, _, err := h.Publish(string(rune('a'+i)), "a", "b", []byte("v"), 0); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	if got := len(h.Recent(0)); got != 0 {
		t.Fatalf("limit 0 returned %d messages", got)
	}
	if got := len(h.Recent(3)); got != 3 {
		t.Fatalf("limit 3 returned %d messages", got)
	}
}
