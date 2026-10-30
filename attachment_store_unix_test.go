//go:build unix

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

func TestAttachmentStoreRejectsSymlinkAndFIFOHandoffWithoutBlocking(t *testing.T) {
	store := openTestAttachmentStore(t)
	item, err := putTestItem(t, store, "pane", "file.txt", []byte("content"))
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(item.Path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, item.Path); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.CreateHandoff("process-1", "pane", []string{item.ID}); err == nil {
		t.Fatal("handoff followed a symlink")
	}
	if err := os.Remove(item.Path); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(item.Path, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, _, err := store.CreateHandoff("process-1", "pane", []string{item.ID})
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("handoff accepted a FIFO")
		}
	case <-time.After(time.Second):
		t.Fatal("handoff blocked while opening a FIFO")
	}
}

func TestAttachmentStoreInterruptedStagingCountsAgainstQuota(t *testing.T) {
	root := t.TempDir()
	store, err := OpenAttachmentStoreAt(root)
	if err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(store.stagingDir, uuid.NewString())
	if err := os.Mkdir(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "partial"), make([]byte, 7), 0o600); err != nil {
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
	used, _, records, _ := store.usageForTest()
	if used < 7 || records == 0 {
		t.Fatalf("incomplete staging not charged: used=%d records=%d", used, records)
	}
	if status := store.ItemStatus(uuid.NewString(), "pane"); status.State != "missing" {
		t.Fatalf("incomplete staging status=%+v", status)
	}
}
