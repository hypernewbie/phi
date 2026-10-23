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
			data := append([]byte(prefix), body...)
			if err := h.Ingest("p", data); err != nil {
				t.Fatal(err)
			}
			ph, _ := h.LookupPane("p")
			defer ph.recording.file.Close()
			c := &Client{Send: make(chan []byte, 8)}
			h.AttachHot("p", c)
			header, _ := parseAttachHead(t, drainOne(c.Send))
			if prefix != "" {
				if header.ReplayFrom != 0 {
					t.Fatalf("unsafe prefix certified at %d", header.ReplayFrom)
				}
				return
			}
			if header.ReplayFrom == 0 || header.Head-header.ReplayFrom > 2*1024*1024 {
				t.Fatalf("plain tail must be bounded and certified: %+v", header)
			}
			if !bytes.Equal(data[header.ReplayFrom-2:header.ReplayFrom], []byte("\r\n")) {
				t.Fatal("raw tail does not begin after a line reset")
			}
			reopened, err := openRecording(ph.recording.path)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.file.Close()
			if got := reopened.replayStart(); got != header.ReplayFrom {
				t.Fatalf("restart changed the prefix certificate: %d != %d", got, header.ReplayFrom)
			}
		})
	}
}

func TestPlainHistoryWithoutEnoughLineResetsCannotSkipItsPrefix(t *testing.T) {
	for _, data := range [][]byte{
		bytes.Repeat([]byte("X"), 3*1024*1024),
		bytes.Repeat([]byte("wide but few rows "), 150000),
	} {
		r, err := openRecording("")
		if err != nil {
			t.Fatal(err)
		}
		if err := r.append(1, data); err != nil {
			t.Fatal(err)
		}
		if from := r.replayStart(); from != 0 {
			t.Fatalf("unknown starting column was certified: %d", from)
		}
		r.file.Close()
	}
}
