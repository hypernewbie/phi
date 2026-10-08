package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestStateEndpointValidatesEpochAndRequestedFrontier(t *testing.T) {
	setupHotHub(t)
	if err := wsHub.Ingest("state", []byte("requested book\r\nLATEST")); err != nil {
		t.Fatal(err)
	}
	pos, _, _, _, err := wsHub.State("state")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		query string
		code  int
	}{
		{"", http.StatusBadRequest},
		{fmt.Sprintf("epoch=%d", pos.Epoch), http.StatusBadRequest},
		{fmt.Sprintf("epoch=%d&through=%d", pos.Epoch+1, pos.Head), http.StatusConflict},
		{fmt.Sprintf("epoch=%d&through=%d", pos.Epoch, pos.Head+1), http.StatusConflict},
		{fmt.Sprintf("epoch=%d&through=%d", pos.Epoch, pos.Head), http.StatusOK},
		{fmt.Sprintf("epoch=%d&through=0", pos.Epoch), http.StatusOK},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/terminals/state/state?"+tc.query, nil)
		w := httptest.NewRecorder()
		handleTerminalState(w, req)
		if w.Code != tc.code {
			t.Fatalf("query %q: got %d want %d: %s", tc.query, w.Code, tc.code, w.Body.String())
		}
		if w.Code == http.StatusOK {
			body := w.Body.Bytes()
			n := int(binary.BigEndian.Uint32(body))
			var header wireproto.AttachHeadHeader
			if err = json.Unmarshal(body[4:4+n], &header); err != nil {
				t.Fatal(err)
			}
			if header.Epoch != pos.Epoch || header.Ckpt == nil || header.Ckpt.Through != header.Head || header.Ckpt.Kind != "ghostty-ready-v1" || header.Ckpt.Len != len(body)-4-n {
				t.Fatalf("bad state envelope: %+v", header)
			}
		}
	}
}
