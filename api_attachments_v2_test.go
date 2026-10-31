package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/textproto"
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hypernewbie/phi/pkg/pty"
)

type attachmentDeadlineRecorder struct {
	*httptest.ResponseRecorder
	fail bool
}

func (w *attachmentDeadlineRecorder) SetReadDeadline(time.Time) error {
	if w.fail {
		return errors.New("deadline not supported")
	}
	return nil
}

func withAttachmentTestGlobals(t *testing.T) {
	t.Helper()
	oldStore, oldManager, oldBridge := attachmentStore, ptyManager, piBridge
	store, err := OpenAttachmentStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	attachmentStore = store
	ptyManager = pty.NewManager()
	piBridge = nil
	t.Cleanup(func() {
		attachmentStore, ptyManager, piBridge = oldStore, oldManager, oldBridge
		_ = store.Close()
	})
}

func withLiveAttachmentPi(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("PTY shell fixture uses Unix sleep")
	}
	cwd := t.TempDir()
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("sleep command unavailable")
	}
	proc, err := pty.Start(t.Context(), cwd, sleep, []string{"60"})
	if err != nil {
		t.Fatalf("start owned PTY: %v", err)
	}
	pane := uuid.NewString()
	ptyManager.AddInstanceForTesting(&pty.PTYInstance{ID: pane, Pty: proc, Cwd: cwd, Coder: "pi"})
	t.Cleanup(func() {
		_ = proc.Kill()
		select {
		case <-proc.Closed:
		case <-time.After(2 * time.Second):
			t.Errorf("owned test PTY did not stop")
		}
	})
	return pane
}

func attachmentMultipartBody(t *testing.T, pane, name, mimeType string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("pane", pane); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("name", name); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="untrusted.bin"`)
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}

func TestHandleAttachmentsV2PutAndStatus(t *testing.T) {
	withAttachmentTestGlobals(t)
	pane := withLiveAttachmentPi(t)
	id := uuid.NewString()
	png := testPNG(t, 2, 2)
	body, contentType := attachmentMultipartBody(t, pane, "screen.png", "image/png", png)
	server := httptest.NewServer(http.HandlerFunc(handleAttachmentsV2Item))
	defer server.Close()
	req, _ := http.NewRequest(http.MethodPut, server.URL+"/api/attachments/v2/items/"+id, body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Origin", server.URL)
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var item AttachmentItem
	if err := json.NewDecoder(response.Body).Decode(&item); err != nil {
		_ = response.Body.Close()
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || item.ID != id || item.Kind != "image" || item.MIMEType != "image/png" {
		t.Fatalf("status=%d item=%+v", response.StatusCode, item)
	}
	stored, err := os.ReadFile(item.Path)
	if err != nil || !bytes.Equal(stored, png) {
		t.Fatalf("stored bytes mismatch: err=%v", err)
	}
	// Status reads use persisted pane ownership, not live-pane admission.
	ptyManager = pty.NewManager()
	statusReq, _ := http.NewRequest(http.MethodGet, server.URL+"/api/attachments/v2/items/"+id+"?pane="+pane, nil)
	statusResp, err := server.Client().Do(statusReq)
	if err != nil {
		t.Fatal(err)
	}
	defer statusResp.Body.Close()
	var status AttachmentStatus
	if err := json.NewDecoder(statusResp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.State != "ready" || status.Item == nil || status.Item.SHA256 != item.SHA256 {
		t.Fatalf("status = %+v", status)
	}
}

func TestHandleAttachmentsV2RejectsForgedImageAndForeignPane(t *testing.T) {
	withAttachmentTestGlobals(t)
	pane := withLiveAttachmentPi(t)
	server := httptest.NewServer(http.HandlerFunc(handleAttachmentsV2Item))
	defer server.Close()
	for _, tc := range []struct {
		name string
		pane string
		data []byte
		mime string
		want int
	}{
		{name: "forged png", pane: pane, data: []byte("not png"), mime: "image/png", want: http.StatusUnsupportedMediaType},
		{name: "foreign pane", pane: uuid.NewString(), data: []byte("text"), mime: "text/plain", want: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := uuid.NewString()
			body, contentType := attachmentMultipartBody(t, tc.pane, tc.name, tc.mime, tc.data)
			req, _ := http.NewRequest(http.MethodPut, server.URL+"/api/attachments/v2/items/"+id, body)
			req.Header.Set("Content-Type", contentType)
			req.Header.Set("Origin", server.URL)
			res, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.want {
				t.Fatalf("status=%d want=%d", res.StatusCode, tc.want)
			}
		})
	}
}

func TestHandleAttachmentsV2RequiresDeadlineSupport(t *testing.T) {
	withAttachmentTestGlobals(t)
	w := &attachmentDeadlineRecorder{ResponseRecorder: httptest.NewRecorder(), fail: true}
	id := uuid.NewString()
	req := httptest.NewRequest(http.MethodPut, "/api/attachments/v2/items/"+id, nil)
	req.Host = "example.test"
	req.Header.Set("Origin", "http://example.test")
	handleAttachmentsV2Item(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d want=%d", w.Code, http.StatusServiceUnavailable)
	}
}

func TestAttachmentSameOriginTLSProxyPolicy(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		site   string
		tls    bool
		host   string
		want   bool
	}{
		{name: "same host clear http", origin: "http://phi.example:7070", host: "phi.example:7070", want: true},
		{name: "same host tls terminated", origin: "https://phi.example:7070", host: "phi.example:7070", want: true},
		{name: "tls requires https", origin: "http://phi.example", host: "phi.example", tls: true, want: false},
		{name: "wrong host", origin: "https://evil.example", host: "phi.example", want: false},
		{name: "cross site", origin: "https://phi.example", host: "phi.example", site: "cross-site", want: false},
		{name: "same site rejected", origin: "https://phi.example", host: "phi.example", site: "same-site", want: false},
		{name: "native client headers absent", host: "phi.example", want: true},
		{name: "path rejected", origin: "https://phi.example/path", host: "phi.example", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "http://"+tc.host+"/api/attachments/v2/items", nil)
			r.Host = tc.host
			if tc.tls {
				r.TLS = &tls.ConnectionState{}
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if tc.site != "" {
				r.Header.Set("Sec-Fetch-Site", tc.site)
			}
			if got := attachmentSameOrigin(r); got != tc.want {
				t.Fatalf("same origin=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestAttachmentV2DeadlinesClearForReusedConnection(t *testing.T) {
	withAttachmentTestGlobals(t)
	pane := withLiveAttachmentPi(t)
	server := httptest.NewServer(http.HandlerFunc(handleAttachmentsV2Item))
	defer server.Close()
	client := server.Client()
	id := uuid.NewString()
	body, contentType := attachmentMultipartBody(t, pane, "file.txt", "text/plain", []byte("hello"))
	req, _ := http.NewRequest(http.MethodPut, server.URL+"/api/attachments/v2/items/"+id, body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Origin", server.URL)
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("PUT status=%d", res.StatusCode)
	}
	var reused bool
	statusReq, _ := http.NewRequest(http.MethodGet, server.URL+"/api/attachments/v2/items/"+id+"?pane="+pane, nil)
	statusReq = statusReq.WithContext(httptrace.WithClientTrace(statusReq.Context(), &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) { reused = info.Reused },
	}))
	statusRes, err := client.Do(statusReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = statusRes.Body.Close()
	if !reused {
		t.Fatal("expected the HTTP connection to be reused after deadline reset")
	}
}

func TestAttachmentV2StalledUploadTimesOutAndDoesNotHoldStatus(t *testing.T) {
	withAttachmentTestGlobals(t)
	pane := withLiveAttachmentPi(t)
	oldTimeout := attachmentPutReadTimeout
	attachmentPutReadTimeout = 100 * time.Millisecond
	t.Cleanup(func() { attachmentPutReadTimeout = oldTimeout })
	server := httptest.NewServer(http.HandlerFunc(handleAttachmentsV2Item))
	defer server.Close()
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	id := uuid.NewString()
	request, _ := http.NewRequest(http.MethodPut, server.URL+"/api/attachments/v2/items/"+id, pr)
	request.Header.Set("Content-Type", mw.FormDataContentType())
	request.Header.Set("Origin", server.URL)
	result := make(chan *http.Response, 1)
	failure := make(chan error, 1)
	go func() {
		response, err := server.Client().Do(request)
		if err != nil {
			failure <- err
			return
		}
		result <- response
	}()
	go func() {
		_ = mw.WriteField("pane", pane)
		_ = mw.WriteField("name", "slow.txt")
		part, err := mw.CreateFormFile("file", "slow.txt")
		if err == nil {
			_, _ = part.Write([]byte("partial"))
		}
		// Keep the body open so the server's real request-body deadline fires.
		time.Sleep(300 * time.Millisecond)
		_ = mw.Close()
		_ = pw.Close()
	}()
	select {
	case response := <-result:
		defer response.Body.Close()
		if response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("status=%d want=%d", response.StatusCode, http.StatusServiceUnavailable)
		}
	case err := <-failure:
		t.Fatalf("upload request error: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("stalled upload did not time out")
	}
	if got := attachmentStore.ItemStatus(id, pane); got.State != "missing" {
		t.Fatalf("stalled upload status=%+v", got)
	}
}
