package ws

import (
	"bytes"
	"testing"
)

func TestPlainHistoryWithoutEnoughLineResetsCannotSkipItsPrefix(t *testing.T) {
	for _, data := range [][]byte{
		bytes.Repeat([]byte("X"), 3*1024*1024),
		bytes.Repeat([]byte("wide but few rows "), 150000),
	} {
		g, err := openRetentionGroup("")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := g.appendPayload(data, nil); err != nil {
			g.close()
			t.Fatal(err)
		}
		if from := g.replayStart(); from != 0 {
			g.close()
			t.Fatalf("unknown starting column was certified: %d", from)
		}
		if err := g.close(); err != nil {
			t.Fatal(err)
		}
	}
}
