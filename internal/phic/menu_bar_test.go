package phic

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func TestCompactMenuBarDoesNotHideSelectedServerOrConsumeChoices(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	c := &client{serverIndex: 19}
	for i := 0; i < 20; i++ {
		c.servers = append(c.servers, &serverState{profile: desktopProfile{Name: fmt.Sprintf("Server%d", i+1)}})
	}
	v := &viewTerminal{input: bytes.NewReader([]byte("\r"))}
	if _, err := c.selectionView(t.Context(), v, func() (int, int, error) { return 35, 10, nil }, "Sessions", []string{"One", "Two", "Three"}, nil); err != nil {
		t.Fatal(err)
	}
	out := v.output.String()
	if !strings.Contains(out, "[20 Server20]") || !strings.Contains(out, "3  Three") {
		t.Fatalf("compact bar lost active identity or crowded out choices: %q", out)
	}
}
