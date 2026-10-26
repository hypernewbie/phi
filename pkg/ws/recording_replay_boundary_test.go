package ws

import (
	"bytes"
	"testing"
)

func TestAttachCertifiesRawTailOnlyForPlainCRLFHistory(t *testing.T) {
	body := bytes.Repeat([]byte("numbered ASCII terminal output\r\n"), 100000)
	for _, prefix := range []string{"", "\x1b[31m", "\x1b[?1049h", "\t", "界", "bare LF\n"} {
		t.Run(prefix, func(t *testing.T) {
			h := NewHub(8)
			if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
				t.Fatal(err)
			}
			data := append([]byte(prefix), body...)
			if err := h.Ingest("p", data); err != nil {
				t.Fatal(err)
			}
			c := &Client{Send: make(chan []byte, 8)}
			h.AttachHot("p", c)
			header := parseAttach(t, drainOne(c.Send))
			if prefix != "" {
				if header.GetReplayFrom() != 0 {
					t.Fatalf("unsafe prefix certified at %d", header.GetReplayFrom())
				}
				return
			}
			if header.GetReplayFrom() == 0 || header.GetHead()-header.GetReplayFrom() > 2*1024*1024 {
				t.Fatalf("plain tail must be bounded and certified: %+v", header)
			}
			if !bytes.Equal(data[header.GetReplayFrom()-2:header.GetReplayFrom()], []byte("\r\n")) {
				t.Fatal("raw tail does not begin after a line reset")
			}
			if err := h.Close(); err != nil {
				t.Fatal(err)
			}
			reopened := NewHub(8)
			t.Cleanup(func() { _ = reopened.Close() })
			if err := reopened.SetRecordingDirectory(h.recordingDirectory); err != nil {
				t.Fatal(err)
			}
			cold := reopened.recordingForRead("p")
			if cold == nil || cold.recording == nil {
				t.Fatal("restart lost the retained group")
			}
			if got := cold.recording.replayStart(); got != header.GetReplayFrom() {
				t.Fatalf("restart changed the prefix certificate: %d != %d", got, header.GetReplayFrom())
			}
		})
	}
}

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
