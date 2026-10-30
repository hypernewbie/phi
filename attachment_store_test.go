package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func testPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.RGBA{R: 0x12, G: 0x34, B: 0x56, A: 0xff})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func testJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 0x12, G: 0x34, B: 0x56, A: 0xff})
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func openTestAttachmentStore(t *testing.T) *AttachmentStore {
	t.Helper()
	store, err := OpenAttachmentStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func putTestItem(t *testing.T, store *AttachmentStore, pane, name string, data []byte) (AttachmentItem, error) {
	t.Helper()
	return store.Put(context.Background(), uuid.NewString(), pane, name, "", bytes.NewReader(data), nil)
}

func TestAttachmentStorePublishesPNGAndRestoresOwnership(t *testing.T) {
	root := t.TempDir()
	store, err := OpenAttachmentStoreAt(root)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	data := testPNG(t, 2, 2)
	item, err := store.Put(context.Background(), id, "pane-a", "sample.png", "", bytes.NewReader(data), nil)
	if err != nil {
		t.Fatal(err)
	}
	if item.Kind != "image" || item.MIMEType != "image/png" || item.SizeBytes != int64(len(data)) {
		t.Fatalf("unexpected metadata: %+v", item)
	}
	hash := sha256.Sum256(data)
	if item.SHA256 != hex.EncodeToString(hash[:]) {
		t.Fatalf("digest = %s", item.SHA256)
	}
	if got := store.ItemStatus(id, "pane-b"); got.State != "missing" {
		t.Fatalf("foreign owner status = %+v", got)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenAttachmentStoreAt(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, err := store.Item(id, "pane-a")
	if err != nil {
		t.Fatal(err)
	}
	if got.SHA256 != item.SHA256 || got.Path != item.Path {
		t.Fatalf("restored item = %+v, want %+v", got, item)
	}
	stored, err := os.ReadFile(got.Path)
	if err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("stored bytes mismatch: err=%v", err)
	}
}

func TestAttachmentStoreClassifiesFilesFromBytes(t *testing.T) {
	store := openTestAttachmentStore(t)
	pngItem, err := putTestItem(t, store, "pane", "wrong.jpg", testPNG(t, 1, 1))
	if err != nil || pngItem.MIMEType != "image/png" {
		t.Fatalf("PNG classification: item=%+v err=%v", pngItem, err)
	}
	jpegItem, err := putTestItem(t, store, "pane", "photo.png", testJPEG(t))
	if err != nil || jpegItem.MIMEType != "image/jpeg" {
		t.Fatalf("JPEG classification: item=%+v err=%v", jpegItem, err)
	}
	fileItem, err := putTestItem(t, store, "pane", "data.bin", []byte{0, 1, 2, 255})
	if err != nil || fileItem.Kind != "file" || fileItem.MIMEType != "application/octet-stream" {
		t.Fatalf("binary classification: item=%+v err=%v", fileItem, err)
	}
	zeroItem, err := putTestItem(t, store, "pane", "empty.txt", nil)
	if err != nil || zeroItem.Kind != "file" || zeroItem.SizeBytes != 0 {
		t.Fatalf("empty file classification: item=%+v err=%v", zeroItem, err)
	}
}

func TestAttachmentStoreRejectsClaimedAndRecognizableUnsupportedImages(t *testing.T) {
	store := openTestAttachmentStore(t)
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{name: "claimed.png", data: []byte("not an image")},
		{name: "animated.gif", data: []byte("GIF89a" + "padding")},
		{name: "animated.png", data: append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 'a', 'c', 'T', 'L'}, make([]byte, 8)...)},
		{name: "vector.svg", data: []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")},
		{name: "broken.png", data: []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := putTestItem(t, store, "pane", tc.name, tc.data)
			if !errors.Is(err, errAttachmentUnsupported) {
				t.Fatalf("error = %v, want unsupported image", err)
			}
		})
	}
}

func TestAttachmentStoreRejectsImageDimensionLimitBeforeDecode(t *testing.T) {
	store, err := openAttachmentStoreAt(t.TempDir(), attachmentStoreLimits{
		maxBytes: 2 << 20, maxRecords: 10, maxFileBytes: 1 << 20,
		maxReserve: 2 << 20, maxActive: 1, maxImagePixels: 32_000_000,
		maxImageDim: 16_384,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, err = putTestItem(t, store, "pane", "wide.png", testPNG(t, 16_385, 1))
	if !errors.Is(err, errAttachmentUnsupported) {
		t.Fatalf("error = %v, want dimension refusal", err)
	}
}

func TestAttachmentStoreSameIDIsIdempotentAndConflictsOnDifferentBytes(t *testing.T) {
	store := openTestAttachmentStore(t)
	id := uuid.NewString()
	data := testPNG(t, 1, 1)
	first, err := store.Put(context.Background(), id, "pane", "one.png", "", bytes.NewReader(data), nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Put(context.Background(), id, "pane", "one.png", "", bytes.NewReader(data), nil)
	if err != nil || second.SHA256 != first.SHA256 || second.Path != first.Path {
		t.Fatalf("same request: item=%+v err=%v", second, err)
	}
	_, err = store.Put(context.Background(), id, "pane", "one.png", "", bytes.NewReader(testPNG(t, 3, 3)), nil)
	if !errors.Is(err, errAttachmentConflict) {
		t.Fatalf("error = %v, want conflict", err)
	}
}

func TestAttachmentStoreRejectsConcurrentDuplicateReservation(t *testing.T) {
	store := openTestAttachmentStore(t)
	id := uuid.NewString()
	reader, writer := io.Pipe()
	result := make(chan error, 1)
	go func() {
		_, err := store.Put(context.Background(), id, "pane", "slow.txt", "", reader, nil)
		result <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for store.ItemStatus(id, "pane").State != "receiving" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	_, err := store.Put(context.Background(), id, "pane", "slow.txt", "", bytes.NewReader([]byte("again")), nil)
	if !errors.Is(err, errAttachmentReceiving) {
		_ = writer.Close()
		t.Fatalf("second error = %v, want receiving", err)
	}
	_, _ = writer.Write([]byte("first"))
	_ = writer.Close()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentStoreWriterLockAndInjectedQuota(t *testing.T) {
	root := t.TempDir()
	limits := attachmentStoreLimits{maxBytes: 12_000, maxRecords: 3, maxFileBytes: 8, maxReserve: 12_000, maxActive: 1, maxImagePixels: 100, maxImageDim: 100}
	store, err := openAttachmentStoreAt(root, limits)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenAttachmentStoreAt(root); !errors.Is(err, errAttachmentStorage) {
		t.Fatalf("second writer error = %v, want storage unavailable", err)
	}
	item, err := putTestItem(t, store, "pane", "a.txt", []byte("abc"))
	if err != nil {
		t.Fatal(err)
	}
	used, _, _, _ := store.usageForTest()
	store.limits.maxBytes = used + 9
	for i := 0; i < 20; i++ {
		if _, _, err := store.CreateHandoff("process-1", "pane", []string{item.ID}); err != nil {
			if !errors.Is(err, errAttachmentLimit) {
				t.Fatalf("handoff error = %v, want quota limit", err)
			}
			break
		}
		if i == 19 {
			t.Fatal("small quota did not refuse new handoff copies")
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentStoreSendRecordSurvivesRestartWithoutReplayStateLoss(t *testing.T) {
	root := t.TempDir()
	store, err := OpenAttachmentStoreAt(root)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	hash := strings.Repeat("a", 64)
	if _, created, err := store.BeginSend(id, "pane", hash); err != nil || !created {
		t.Fatalf("begin: created=%v err=%v", created, err)
	}
	if err := store.UpdateSend(id, true, "unknown", "uncertain"); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenAttachmentStoreAt(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	record, err := store.Send(id, "pane")
	if err != nil || !record.Attempted || record.State != "unknown" {
		t.Fatalf("record=%+v err=%v", record, err)
	}
	if _, created, err := store.BeginSend(id, "pane", hash); err != nil || created {
		t.Fatalf("duplicate begin: created=%v err=%v", created, err)
	}
}

func TestAttachmentStoreLockFileIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX file modes do not represent Windows ACLs")
	}
	store := openTestAttachmentStore(t)
	info, err := os.Stat(filepath.Join(store.root, ".lock"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("lock permissions = %o", info.Mode().Perm())
	}
}

func TestAttachmentStoreHandoffEnforcesEightItemAndTotalLimits(t *testing.T) {
	store := openTestAttachmentStore(t)
	ids := make([]string, 0, 8)
	wantSHA := make([]string, 0, 8)
	for i := 0; i < 8; i++ {
		item, err := putTestItem(t, store, "pane", "file.txt", []byte{byte(i), 'd', 'a', 't', 'a'})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, item.ID)
		wantSHA = append(wantSHA, item.SHA256)
	}
	_, refs, err := store.CreateHandoff("process-1", "pane", ids)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 8 {
		t.Fatalf("refs=%d want 8", len(refs))
	}
	for i, ref := range refs {
		if ref.SHA256 != wantSHA[i] {
			t.Fatalf("ref %d sha=%s want %s", i, ref.SHA256, wantSHA[i])
		}
	}
	if _, _, err := store.CreateHandoff("process-1", "pane", append(ids, uuid.NewString())); !errors.Is(err, errAttachmentInvalid) {
		t.Fatalf("nine-item error = %v, want invalid", err)
	}
	if _, _, err := store.CreateHandoff("process-1", "pane", nil); !errors.Is(err, errAttachmentInvalid) {
		t.Fatalf("empty error = %v, want invalid", err)
	}
	big := make([]string, 0, 3)
	for i := 0; i < 3; i++ {
		item, err := putTestItem(t, store, "pane", "big.bin", make([]byte, 20<<20))
		if err != nil {
			t.Fatal(err)
		}
		big = append(big, item.ID)
	}
	if _, _, err := store.CreateHandoff("process-1", "pane", big); !errors.Is(err, errAttachmentLimit) {
		t.Fatalf("oversize-total error = %v, want limit", err)
	}
}
