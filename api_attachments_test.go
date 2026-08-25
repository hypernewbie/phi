package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/rpc"
)

func withTempHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	homeKey := "HOME"
	if runtime.GOOS == "windows" {
		homeKey = "USERPROFILE"
	}
	t.Setenv(homeKey, tmp)
	t.Setenv("HOME", tmp)
	previous := attachmentState
	attachmentState = newAttachmentStore()
	t.Cleanup(func() { attachmentState = previous })
	return tmp
}

func attachmentFixturePNG(size int) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		panic(err)
	}
	data := buf.Bytes()
	if size <= len(data) {
		return append([]byte(nil), data...)
	}
	return append(append([]byte(nil), data...), make([]byte, size-len(data))...)
}

func attachmentFixturePNGDimensions(width, height int) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func attachmentFixtureJPEG() []byte {
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1, 1)), nil)
	return buf.Bytes()
}

func attachmentFixtureGIF() []byte {
	var buf bytes.Buffer
	_ = gif.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1, 1)), nil)
	return buf.Bytes()
}

func largePNGHeader(width, height uint32) []byte {
	chunk := make([]byte, 25)
	binary.BigEndian.PutUint32(chunk[0:4], 13)
	copy(chunk[4:8], []byte("IHDR"))
	binary.BigEndian.PutUint32(chunk[8:12], width)
	binary.BigEndian.PutUint32(chunk[12:16], height)
	chunk[16] = 8
	chunk[17] = 6
	binary.BigEndian.PutUint32(chunk[21:25], crc32.ChecksumIEEE(chunk[4:21]))
	return append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, chunk...)
}

func newMultipartRequest(t *testing.T, fieldName, filename, mime string, content []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, fieldName, filename))
	h.Set("Content-Type", mime)
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/attachments", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func uploadAttachment(t *testing.T, mime string, data []byte) (rpc.QueueAttachment, map[string]any) {
	t.Helper()
	req := newMultipartRequest(t, "file", "client-name.png", mime, data)
	w := httptest.NewRecorder()
	handleAttachments(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("upload status=%d body=%s", w.Code, w.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	ref, _ := response["ref"].(string)
	name, _ := response["name"].(string)
	size, _ := response["sizeBytes"].(float64)
	mimeType, _ := response["mimeType"].(string)
	return rpc.QueueAttachment{Ref: ref, Name: name, MimeType: mimeType, SizeBytes: int64(size)}, response
}

func TestHandleAttachments_HappyPathOpaqueRefAndPrivateModes(t *testing.T) {
	home := withTempHome(t)
	data := attachmentFixturePNG(0)
	attachment, response := uploadAttachment(t, "image/png", data)
	if _, ok := response["path"]; ok {
		t.Fatal("upload response exposed an absolute path")
	}
	if !validAttachmentRef(attachment.Ref) || len(attachment.Ref) != 64 {
		t.Fatalf("invalid opaque ref %q", attachment.Ref)
	}
	if attachment.MimeType != "image/png" || attachment.SizeBytes != int64(len(data)) {
		t.Fatalf("metadata=%+v", attachment)
	}
	path := filepath.Join(home, ".phi", "clipboard", attachment.Name)
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("stored bytes mismatch err=%v", err)
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := dirInfo.Mode().Perm(); mode != 0o700 {
		t.Fatalf("directory mode=%o want 700", mode)
	}
	if mode := fileInfo.Mode().Perm(); mode != 0o600 {
		t.Fatalf("file mode=%o want 600", mode)
	}
}

func TestHandleAttachmentsAcceptsStandardImages(t *testing.T) {
	withTempHome(t)
	for _, test := range []struct {
		mime string
		data []byte
	}{
		{"image/png", attachmentFixturePNG(0)},
		{"image/jpeg", attachmentFixtureJPEG()},
		{"image/gif", attachmentFixtureGIF()},
	} {
		attachment, _ := uploadAttachment(t, test.mime, test.data)
		if attachment.MimeType != test.mime {
			t.Fatalf("mime=%q want %q", attachment.MimeType, test.mime)
		}
	}
}

func TestHandleAttachmentsRejectsMIMEAndImageFailures(t *testing.T) {
	withTempHome(t)
	cases := []struct {
		name string
		mime string
		data []byte
		code int
	}{
		{"declared mismatch", "image/jpeg", attachmentFixturePNG(0), http.StatusBadRequest},
		{"invalid bytes", "image/png", []byte("not an image"), http.StatusBadRequest},
		{"pixel bomb", "image/png", largePNGHeader(5000, 5000), http.StatusBadRequest},
		{"oversize", "image/png", attachmentFixturePNG(attachmentMaxBytes + 1), http.StatusRequestEntityTooLarge},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			req := newMultipartRequest(t, "file", "x.png", test.mime, test.data)
			w := httptest.NewRecorder()
			handleAttachments(w, req)
			if w.Code != test.code {
				t.Fatalf("status=%d body=%s want=%d", w.Code, w.Body.String(), test.code)
			}
		})
	}
}

func TestHandleAttachmentsRejectsWrongMethodAndMissingField(t *testing.T) {
	withTempHome(t)
	get := httptest.NewRequest(http.MethodGet, "/api/attachments", nil)
	w := httptest.NewRecorder()
	handleAttachments(w, get)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status=%d", w.Code)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("wrong", "x")
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/attachments", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w = httptest.NewRecorder()
	handleAttachments(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing field status=%d", w.Code)
	}
}

func TestAttachmentResolverRejectsCombinedDecodedImageLimit(t *testing.T) {
	withTempHome(t)
	firstData := attachmentFixturePNGDimensions(2100, 2000)
	secondData := attachmentFixturePNGDimensions(2100, 2000)
	first, _ := uploadAttachment(t, "image/png", firstData)
	second, _ := uploadAttachment(t, "image/png", secondData)
	_, err := attachmentState.ResolveAttachments(nil, "anonymous", "sid", "epoch", "item", []string{first.Ref, second.Ref})
	if err == nil || !strings.Contains(err.Error(), "decoded input limit") {
		t.Fatalf("combined decoded-size claim err=%v", err)
	}
	attachmentState.mu.Lock()
	defer attachmentState.mu.Unlock()
	for _, ref := range []string{first.Ref, second.Ref} {
		if record := attachmentState.records[ref]; record == nil || record.Lease == nil || record.Lease.Kind != attachmentLeaseProvisional {
			t.Fatalf("failed claim was not left provisional for %s: %+v", ref, record)
		}
	}
}

func TestAttachmentResolverClaimsOwnerAndSid(t *testing.T) {
	withTempHome(t)
	attachment, _ := uploadAttachment(t, "image/png", attachmentFixturePNG(0))
	claimed, err := attachmentState.ResolveAttachments(nil, "anonymous", "sid-a", "epoch-a", "item-a", []string{attachment.Ref})
	if err != nil || len(claimed) != 1 || len(claimed[0].Data) == 0 {
		t.Fatalf("claim=%+v err=%v", claimed, err)
	}
	if _, err := attachmentState.ResolveAttachments(nil, "anonymous", "sid-b", "epoch-a", "item-b", []string{attachment.Ref}); err == nil {
		t.Fatal("cross-sid claim succeeded")
	}
	if _, err := attachmentState.ResolveAttachments(nil, "other-owner", "sid-a", "epoch-a", "item-c", []string{attachment.Ref}); err == nil {
		t.Fatal("cross-owner claim succeeded")
	}
	if _, err := attachmentState.ResolveAttachments(nil, "anonymous", "sid-a", "epoch-a", "item-c", []string{"/tmp/browser-path.png"}); err == nil {
		t.Fatal("arbitrary browser path was accepted as an attachment ref")
	}
	copied, err := attachmentState.CopyAttachments(nil, "anonymous", "sid-a", "epoch-a", "item-a", claimed)
	if err != nil || len(copied) != 1 || copied[0].Ref == attachment.Ref {
		t.Fatalf("copy=%+v err=%v", copied, err)
	}
	if err := attachmentState.ReleaseAttachments(nil, "anonymous", "sid-a", "epoch-a", "item-a", []string{attachment.Ref}); err != nil {
		t.Fatal(err)
	}
	if !attachmentState.ReleaseProvisional("anonymous", copied[0].Ref) {
		t.Fatal("copied provisional lease was not released")
	}
}

func TestAttachmentCleanupSkipsLeasesAndManualClearReportsCounts(t *testing.T) {
	withTempHome(t)
	first, _ := uploadAttachment(t, "image/png", attachmentFixturePNG(0))
	second, _ := uploadAttachment(t, "image/png", attachmentFixturePNG(0))
	if !attachmentState.ReleaseProvisional("anonymous", second.Ref) {
		t.Fatal("second provisional lease was not released")
	}
	if _, err := attachmentState.ResolveAttachments(nil, "anonymous", "sid", "epoch", "item", []string{first.Ref}); err != nil {
		t.Fatal(err)
	}
	counts := attachmentState.cleanup(Config{AttachmentRetentionAgeSeconds: defaultAttachmentRetentionAgeSeconds, AttachmentJanitorIntervalSeconds: defaultAttachmentJanitorIntervalSeconds}, true)
	if counts.SkippedLeasedFiles != 1 || counts.RemovedFiles != 1 {
		t.Fatalf("cleanup counts=%+v", counts)
	}
	if _, err := os.Stat(filepath.Join(attachmentDir(), first.Name)); err != nil {
		t.Fatalf("leased file removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(attachmentDir(), second.Name)); !os.IsNotExist(err) {
		t.Fatalf("unleased file remains: %v", err)
	}
}

func TestAttachmentClearIsScopedToAuthenticatedOwner(t *testing.T) {
	withTempHome(t)
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	auth.mu.Lock()
	auth.sessions["session-a"] = expires
	auth.sessions["session-b"] = expires
	auth.mu.Unlock()

	ownerRequest := func(token string) *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/attachments/clear", nil)
		req.AddCookie(&http.Cookie{Name: accessSessionCookie, Value: token})
		return req
	}
	ownerA, err := attachmentOwnerForRequest(ownerRequest("session-a"))
	if err != nil {
		t.Fatal(err)
	}
	ownerB, err := attachmentOwnerForRequest(ownerRequest("session-b"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := attachmentState.upload(ownerA, "image/png", attachmentFixturePNG(0))
	if err != nil {
		t.Fatal(err)
	}
	second, err := attachmentState.upload(ownerB, "image/png", attachmentFixturePNG(0))
	if err != nil {
		t.Fatal(err)
	}
	if !attachmentState.ReleaseProvisional(ownerA, first.Ref) || !attachmentState.ReleaseProvisional(ownerB, second.Ref) {
		t.Fatal("failed to stage owner fixtures")
	}

	w := httptest.NewRecorder()
	handleAttachmentClear(w, ownerRequest("session-a"))
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), second.Name) {
		t.Fatalf("owner-scoped clear response=%d body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(attachmentDir(), first.Name)); !os.IsNotExist(err) {
		t.Fatalf("owner A file remains: %v", err)
	}
	if _, err := os.Stat(filepath.Join(attachmentDir(), second.Name)); err != nil {
		t.Fatalf("owner B file was deleted: %v", err)
	}
}

func TestAttachmentProvisionalLeaseExpiresAfterThirtyMinutes(t *testing.T) {
	withTempHome(t)
	oldNow := attachmentNow
	now := time.Unix(1000, 0)
	attachmentNow = func() time.Time { return now }
	t.Cleanup(func() { attachmentNow = oldNow })

	attachment, err := attachmentState.upload("anonymous", "image/png", attachmentFixturePNG(0))
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(attachmentProvisionalTTL)
	if _, err := attachmentState.ResolveAttachments(nil, "anonymous", "sid", "epoch", "item", []string{attachment.Ref}); err == nil || !strings.Contains(err.Error(), "lease expired") {
		t.Fatalf("expired provisional claim error=%v", err)
	}
	attachmentState.mu.Lock()
	_, retained := attachmentState.records[attachment.Ref]
	attachmentState.mu.Unlock()
	if retained {
		t.Fatal("expired provisional reference authority was retained")
	}
	if _, err := os.Stat(filepath.Join(attachmentDir(), attachment.Name)); err != nil {
		t.Fatalf("expired lease removed the retained file before janitor: %v", err)
	}
}

func TestAttachmentCleanupSkipsOverlappingRun(t *testing.T) {
	withTempHome(t)
	attachment, _ := uploadAttachment(t, "image/png", attachmentFixturePNG(0))
	if !attachmentState.ReleaseProvisional("anonymous", attachment.Ref) {
		t.Fatal("failed to release overlap fixture")
	}
	path := filepath.Join(attachmentDir(), attachment.Name)
	if err := os.Chtimes(path, time.Unix(0, 0), time.Unix(0, 0)); err != nil {
		t.Fatal(err)
	}
	attachmentState.cleanupMu.Lock()
	result := make(chan attachmentCleanupCounts, 1)
	go func() {
		result <- attachmentState.cleanup(Config{AttachmentRetentionAgeSeconds: 1}, false)
	}()
	select {
	case counts := <-result:
		if counts != (attachmentCleanupCounts{}) {
			t.Fatalf("overlapping cleanup counts=%+v", counts)
		}
	case <-time.After(100 * time.Millisecond):
		attachmentState.cleanupMu.Unlock()
		t.Fatal("overlapping cleanup did not skip")
	}
	attachmentState.cleanupMu.Unlock()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("overlapping cleanup removed file: %v", err)
	}
}

func TestAttachmentJanitorExpiresProvisionalWithoutIgnoringRetention(t *testing.T) {
	withTempHome(t)
	oldNow := attachmentNow
	now := time.Unix(1000, 0)
	attachmentNow = func() time.Time { return now }
	t.Cleanup(func() { attachmentNow = oldNow })

	attachment, err := attachmentState.upload("anonymous", "image/png", attachmentFixturePNG(0))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(attachmentDir(), attachment.Name)
	if err := os.Chtimes(path, now, now); err != nil {
		t.Fatal(err)
	}
	now = now.Add(attachmentProvisionalTTL)
	counts := attachmentState.cleanup(Config{
		AttachmentRetentionAgeSeconds:    defaultAttachmentRetentionAgeSeconds,
		AttachmentJanitorIntervalSeconds: defaultAttachmentJanitorIntervalSeconds,
	}, false)
	if counts.RemovedFiles != 0 {
		t.Fatalf("expired provisional ignored retention: %+v", counts)
	}
	attachmentState.mu.Lock()
	record := attachmentState.records[attachment.Ref]
	attachmentState.mu.Unlock()
	if record == nil || !record.Expired || record.Lease != nil {
		t.Fatalf("expired provisional record=%+v", record)
	}
	if _, err := attachmentState.ResolveAttachments(nil, "anonymous", "sid", "epoch", "item", []string{attachment.Ref}); err == nil {
		t.Fatal("expired provisional reference was claimable after janitor")
	}
	now = now.Add(time.Duration(defaultAttachmentRetentionAgeSeconds) * time.Second)
	counts = attachmentState.cleanup(Config{
		AttachmentRetentionAgeSeconds:    defaultAttachmentRetentionAgeSeconds,
		AttachmentJanitorIntervalSeconds: defaultAttachmentJanitorIntervalSeconds,
	}, false)
	if counts.RemovedFiles != 1 {
		t.Fatalf("retained expired file was not removed at age: %+v", counts)
	}
}

func TestAttachmentJanitorHonorsAgeAndCap(t *testing.T) {
	withTempHome(t)
	oldNow := attachmentNow
	attachmentNow = func() time.Time { return time.Unix(1000, 0) }
	t.Cleanup(func() { attachmentNow = oldNow })
	first, _ := uploadAttachment(t, "image/png", attachmentFixturePNG(0))
	second, _ := uploadAttachment(t, "image/png", attachmentFixturePNG(0))
	if !attachmentState.ReleaseProvisional("anonymous", first.Ref) || !attachmentState.ReleaseProvisional("anonymous", second.Ref) {
		t.Fatal("failed to release test provisional leases")
	}
	firstPath := filepath.Join(attachmentDir(), first.Name)
	secondPath := filepath.Join(attachmentDir(), second.Name)
	_ = os.Chtimes(firstPath, time.Unix(0, 0), time.Unix(0, 0))
	_ = os.Chtimes(secondPath, time.Unix(900, 0), time.Unix(900, 0))
	cfg := Config{AttachmentRetentionAgeSeconds: 500, AttachmentUnleasedFileCap: 0, AttachmentJanitorIntervalSeconds: 86400}
	counts := attachmentState.cleanup(cfg, false)
	if counts.RemovedFiles != 1 {
		t.Fatalf("age cleanup counts=%+v", counts)
	}
	third, _ := uploadAttachment(t, "image/png", attachmentFixturePNG(0))
	if !attachmentState.ReleaseProvisional("anonymous", third.Ref) {
		t.Fatal("failed to release newest provisional lease")
	}
	cfg.AttachmentRetentionAgeSeconds = 0
	cfg.AttachmentUnleasedFileCap = 1
	counts = attachmentState.cleanup(cfg, false)
	if counts.RemovedFiles != 1 {
		t.Fatalf("cap cleanup counts=%+v", counts)
	}
	if _, err := os.Stat(filepath.Join(attachmentDir(), third.Name)); err != nil {
		t.Fatalf("newest file removed by cap: %v", err)
	}
}

func TestAttachmentRoutes(t *testing.T) {
	withTempHome(t)
	withTempConfig(t)
	body := strings.NewReader(`{"attachment_retention_age_seconds":-1,"attachment_unleased_file_cap":-2,"attachment_janitor_interval_seconds":1}`)
	req := httptest.NewRequest(http.MethodPost, "/api/config/attachments", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleAttachmentConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("config status=%d body=%s", w.Code, w.Body.String())
	}
	var got map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["attachment_retention_age_seconds"] != float64(defaultAttachmentRetentionAgeSeconds) || got["attachment_unleased_file_cap"] != float64(0) || got["attachment_janitor_interval_seconds"] != float64(minimumAttachmentJanitorIntervalSeconds) {
		t.Fatalf("normalized config=%v", got)
	}
	attachment, _ := uploadAttachment(t, "image/png", attachmentFixturePNG(0))
	releaseBody := strings.NewReader(fmt.Sprintf(`{"ref":%q}`, attachment.Ref))
	releaseReq := httptest.NewRequest(http.MethodPost, "/api/attachments/release", releaseBody)
	releaseW := httptest.NewRecorder()
	handleAttachmentRelease(releaseW, releaseReq)
	if releaseW.Code != http.StatusOK || !strings.Contains(releaseW.Body.String(), `"released":true`) {
		t.Fatalf("release response=%d %s", releaseW.Code, releaseW.Body.String())
	}
	clearReq := httptest.NewRequest(http.MethodPost, "/api/attachments/clear", nil)
	clearW := httptest.NewRecorder()
	handleAttachmentClear(clearW, clearReq)
	if clearW.Code != http.StatusOK || strings.Contains(clearW.Body.String(), "/.phi/") {
		t.Fatalf("clear response=%d %s", clearW.Code, clearW.Body.String())
	}
}

var _ = textproto.MIMEHeader{}
