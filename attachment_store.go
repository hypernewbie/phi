package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/hypernewbie/phi/pkg/system"
)

const (
	attachmentStoreName       = "attachments-v2"
	attachmentItemsDir        = "items"
	attachmentStagingDir      = "staging"
	attachmentSendsDir        = "sends"
	attachmentHandoffDir      = "handoff"
	attachmentStoreMaxBytes   = int64(1 << 30)
	attachmentStoreMaxRecords = 10_000
	attachmentUploadMaxBytes  = int64(25 << 20)
	attachmentReserveMaxBytes = int64(64 << 20)
	attachmentMaxNameBytes    = 1_024
	attachmentMaxActive       = 2
	attachmentImageMaxPixels  = int64(32_000_000)
	attachmentImageMaxDim     = 16_384
	attachmentImageProbeBytes = 1 << 20
	attachmentHandoffMaxRefs  = 8
	attachmentHandoffMaxTotal = int64(50 << 20)
	attachmentHandoffMaxName  = 128
)

var (
	errAttachmentInvalid     = errors.New("attachment: invalid request")
	errAttachmentConflict    = errors.New("attachment: id conflict")
	errAttachmentReceiving   = errors.New("attachment: item is receiving")
	errAttachmentNotFound    = errors.New("attachment: item not found")
	errAttachmentForbidden   = errors.New("attachment: owner mismatch")
	errAttachmentLimit       = errors.New("attachment: limit reached")
	errAttachmentUnsupported = errors.New("attachment: unsupported image")
	errAttachmentChanged     = errors.New("attachment: source changed")
	errAttachmentStorage     = errors.New("attachment: storage unavailable")
)

// AttachmentItem is metadata for one immutable item. Path is a server-local
// Pi tool reference. No route serves the bytes to the browser.
type AttachmentItem struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	MIMEType  string `json:"mimeType"`
	Kind      string `json:"kind"`
	SHA256    string `json:"sha256"`
	PaneID    string `json:"-"`
}

type attachmentDiskItem struct {
	AttachmentItem
	PaneID string `json:"pane_id"`
}

type attachmentSendRecord struct {
	ID          string `json:"id"`
	PaneID      string `json:"pane_id"`
	RequestHash string `json:"request_hash"`
	State       string `json:"state"`
	Reason      string `json:"reason,omitempty"`
	Attempted   bool   `json:"attempted"`
}

type attachmentReservation struct {
	pane string
	name string
}

type attachmentStoreLimits struct {
	maxBytes       int64
	maxRecords     int
	maxFileBytes   int64
	maxReserve     int64
	maxActive      int
	maxImagePixels int64
	maxImageDim    int
}

func defaultAttachmentStoreLimits() attachmentStoreLimits {
	return attachmentStoreLimits{
		maxBytes: attachmentStoreMaxBytes, maxRecords: attachmentStoreMaxRecords,
		maxFileBytes: attachmentUploadMaxBytes, maxReserve: attachmentReserveMaxBytes,
		maxActive: attachmentMaxActive, maxImagePixels: attachmentImageMaxPixels,
		maxImageDim: attachmentImageMaxDim,
	}
}

// AttachmentStore owns the v2 immutable items and send tombstones. The
// process-wide file lock prevents a second Phi process from racing quota or
// publication. The old clipboard store is deliberately separate.
type AttachmentStore struct {
	root       string
	itemsDir   string
	stagingDir string
	sendsDir   string
	handoffDir string
	lock       *attachmentStoreLock
	limits     attachmentStoreLimits

	mu              sync.Mutex
	decodeMu        chan struct{}
	items           map[string]AttachmentItem
	sends           map[string]attachmentSendRecord
	receiving       map[string]attachmentReservation
	usedBytes       int64
	reserved        int64
	active          int
	records         int
	reservedRecords int
	closed          bool
}

var attachmentStore *AttachmentStore

// OpenAttachmentStore opens the one-writer v2 store. A failure disables only
// attachment routes; callers must let Phi and unrelated bridge features run.
func OpenAttachmentStore() (*AttachmentStore, error) {
	return OpenAttachmentStoreAt(filepath.Join(system.PhiDataDir(), attachmentStoreName))
}

// OpenAttachmentStoreAt is exported for isolated tests.
func OpenAttachmentStoreAt(root string) (*AttachmentStore, error) {
	return openAttachmentStoreAt(root, defaultAttachmentStoreLimits())
}

func openAttachmentStoreAt(root string, limits attachmentStoreLimits) (*AttachmentStore, error) {
	if limits.maxBytes < 1 || limits.maxRecords < 1 || limits.maxFileBytes < 1 || limits.maxReserve < limits.maxFileBytes || limits.maxActive < 1 || limits.maxImagePixels < 1 || limits.maxImageDim < 1 {
		return nil, fmt.Errorf("%w: invalid test limits", errAttachmentStorage)
	}
	if !filepath.IsAbs(root) {
		return nil, fmt.Errorf("%w: store root must be absolute", errAttachmentStorage)
	}
	if err := ensureAttachmentDir(root); err != nil {
		return nil, fmt.Errorf("%w: create root", errAttachmentStorage)
	}
	lock, err := lockAttachmentStore(filepath.Join(root, ".lock"))
	if err != nil {
		return nil, fmt.Errorf("%w: writer lock", errAttachmentStorage)
	}
	s := &AttachmentStore{
		root:       root,
		itemsDir:   filepath.Join(root, attachmentItemsDir),
		stagingDir: filepath.Join(root, attachmentStagingDir),
		sendsDir:   filepath.Join(root, attachmentSendsDir),
		handoffDir: filepath.Join(root, attachmentHandoffDir),
		lock:       lock,
		limits:     limits,
		decodeMu:   make(chan struct{}, 1),
		items:      make(map[string]AttachmentItem),
		sends:      make(map[string]attachmentSendRecord),
		receiving:  make(map[string]attachmentReservation),
	}
	for _, dir := range []string{s.itemsDir, s.stagingDir, s.sendsDir, s.handoffDir} {
		if err := ensureAttachmentDir(dir); err != nil {
			_ = lock.Close()
			return nil, fmt.Errorf("%w: create store directory", errAttachmentStorage)
		}
	}
	if err := s.scan(); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("%w: reconcile store", errAttachmentStorage)
	}
	return s, nil
}

func ensureAttachmentDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("not a directory")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o700); err != nil {
			return err
		}
	}
	return nil
}

func (s *AttachmentStore) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	return s.lock.Close()
}

func canonicalAttachmentUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 4 && parsed.String() == value
}

func safeHandoffProcessID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-') {
			return false
		}
	}
	return value != "." && value != ".."
}

func (s *AttachmentStore) scan() error {
	var bytes int64
	var records int
	if err := filepath.WalkDir(s.root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == s.root {
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink in store")
		}
		if d.IsDir() {
			if filepath.Dir(path) == s.itemsDir || filepath.Dir(path) == s.stagingDir {
				records++
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("special file in store")
		}
		bytes += info.Size()
		if bytes > s.limits.maxBytes {
			return fmt.Errorf("store quota exceeded")
		}
		return nil
	}); err != nil {
		return err
	}

	entries, err := os.ReadDir(s.itemsDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !canonicalAttachmentUUID(entry.Name()) {
			return fmt.Errorf("invalid item entry")
		}
		itemDir := filepath.Join(s.itemsDir, entry.Name())
		metaPath := filepath.Join(itemDir, "metadata.json")
		metaBytes, err := os.ReadFile(metaPath)
		if errors.Is(err, os.ErrNotExist) {
			// Interrupted staging/publication is unusable but remains
			// charged to the quota. Never expose partial bytes.
			continue
		}
		if err != nil {
			return err
		}
		var diskItem attachmentDiskItem
		if err := json.Unmarshal(metaBytes, &diskItem); err != nil {
			return err
		}
		item := diskItem.AttachmentItem
		item.PaneID = diskItem.PaneID
		dataPath := item.Path
		base := filepath.Base(dataPath)
		if filepath.Dir(dataPath) != itemDir || (base != "file.png" && base != "file.jpg" && base != "file.bin") {
			return fmt.Errorf("invalid item path")
		}
		info, err := os.Lstat(dataPath)
		if err != nil || !info.Mode().IsRegular() || item.ID != entry.Name() || item.SizeBytes != info.Size() || item.PaneID == "" || item.SHA256 == "" {
			return fmt.Errorf("invalid item metadata")
		}
		s.items[item.ID] = item
	}

	sendEntries, err := os.ReadDir(s.sendsDir)
	if err != nil {
		return err
	}
	for _, entry := range sendEntries {
		if strings.HasPrefix(entry.Name(), ".send-") && strings.HasSuffix(entry.Name(), ".tmp") {
			records++
			continue
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			return fmt.Errorf("invalid send entry")
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !canonicalAttachmentUUID(id) {
			return fmt.Errorf("invalid send id")
		}
		data, err := os.ReadFile(filepath.Join(s.sendsDir, entry.Name()))
		if err != nil {
			return err
		}
		var record attachmentSendRecord
		if err := json.Unmarshal(data, &record); err != nil || record.ID != id || record.PaneID == "" || record.RequestHash == "" {
			return fmt.Errorf("invalid send record")
		}
		if record.State != "pending" && record.State != "refused" && record.State != "dispatched" && record.State != "unknown" {
			return fmt.Errorf("invalid send state")
		}
		if record.Attempted && record.State == "pending" {
			record.State = "unknown"
			if err := s.writeSendLocked(record); err != nil {
				return err
			}
		}
		s.sends[id] = record
	}
	records += len(s.sends)
	if records > s.limits.maxRecords {
		return fmt.Errorf("operation record limit exceeded")
	}
	s.usedBytes = bytes
	s.records = records
	return nil
}

func writeSyncedFile(path string, data []byte, mode os.FileMode, exclusive bool) error {
	flags := os.O_WRONLY | os.O_CREATE
	if exclusive {
		flags |= os.O_EXCL
	} else {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func syncAttachmentDir(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func randomAttachmentID() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

type AttachmentStatus struct {
	State string          `json:"state"`
	Item  *AttachmentItem `json:"item,omitempty"`
}

func (s *AttachmentStore) ItemStatus(id, paneID string) AttachmentStatus {
	if s == nil {
		return AttachmentStatus{State: "missing"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AttachmentStatus{State: "missing"}
	}
	if receiving, ok := s.receiving[id]; ok {
		if receiving.pane == paneID {
			return AttachmentStatus{State: "receiving"}
		}
		return AttachmentStatus{State: "missing"}
	}
	item, ok := s.items[id]
	if !ok || item.PaneID != paneID {
		return AttachmentStatus{State: "missing"}
	}
	copy := item
	return AttachmentStatus{State: "ready", Item: &copy}
}

func (s *AttachmentStore) reserveUpload(id, paneID, name string) (string, bool, error) {
	if !canonicalAttachmentUUID(id) || paneID == "" || len(paneID) > 256 || !utf8.ValidString(name) || len(name) > attachmentMaxNameBytes {
		return "", false, errAttachmentInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", false, errAttachmentStorage
	}
	if prior, ok := s.receiving[id]; ok {
		if prior.pane != paneID || prior.name != name {
			return "", false, errAttachmentConflict
		}
		return "", false, errAttachmentReceiving
	}
	if s.active >= s.limits.maxActive {
		return "", false, errAttachmentLimit
	}
	_, exists := s.items[id]
	if !exists && s.records+s.reservedRecords >= s.limits.maxRecords {
		return "", false, errAttachmentLimit
	}
	reserve := s.limits.maxFileBytes + attachmentMaxNameBytes + 4096
	if s.reserved+reserve > s.limits.maxReserve || s.usedBytes+s.reserved+reserve > s.limits.maxBytes {
		return "", false, errAttachmentLimit
	}
	stageID, err := randomAttachmentID()
	if err != nil {
		return "", false, errAttachmentStorage
	}
	stage := filepath.Join(s.stagingDir, stageID)
	if err := os.Mkdir(stage, 0o700); err != nil {
		return "", false, errAttachmentStorage
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(stage, 0o700); err != nil {
			_ = os.RemoveAll(stage)
			return "", false, errAttachmentStorage
		}
	}
	s.receiving[id] = attachmentReservation{pane: paneID, name: name}
	s.active++
	s.reserved += reserve
	if !exists {
		s.reservedRecords++
	}
	return stage, exists, nil
}

func (s *AttachmentStore) releaseUpload(id, stage string, existed, committed bool, item AttachmentItem, storedBytes int64) {
	s.mu.Lock()
	delete(s.receiving, id)
	if s.active > 0 {
		s.active--
	}
	s.reserved -= s.limits.maxFileBytes + attachmentMaxNameBytes + 4096
	if s.reserved < 0 {
		s.reserved = 0
	}
	if !existed && s.reservedRecords > 0 {
		s.reservedRecords--
	}
	if committed {
		if !existed {
			s.records++
		}
		s.items[id] = item
		s.usedBytes += storedBytes
	}
	s.mu.Unlock()
	if stage != "" {
		_ = os.RemoveAll(stage)
	}
}

// SnapshotFile copies one checked server-local regular file into the private
// item store. The browser supplies only the path it selected and the listing
// fingerprint; Pi receives the generated private snapshot path.
func (s *AttachmentStore) SnapshotFile(ctx context.Context, id, paneID, sourcePath, expectedFingerprint string) (AttachmentItem, error) {
	if !canonicalAttachmentUUID(id) || paneID == "" || len(paneID) > 256 || len(sourcePath) > 4096 || !filepath.IsAbs(sourcePath) || len(expectedFingerprint) != 64 {
		return AttachmentItem{}, errAttachmentInvalid
	}
	if _, err := hex.DecodeString(expectedFingerprint); err != nil || strings.ToLower(expectedFingerprint) != expectedFingerprint {
		return AttachmentItem{}, errAttachmentInvalid
	}
	sourcePath = filepath.Clean(sourcePath)
	name := filepath.Base(sourcePath)
	if name == "." || name == string(filepath.Separator) || !utf8.ValidString(name) || len(name) > attachmentMaxNameBytes {
		return AttachmentItem{}, errAttachmentInvalid
	}
	file, err := openAttachmentSource(sourcePath)
	if err != nil {
		return AttachmentItem{}, errAttachmentChanged
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || attachmentSourceFingerprint(before) != expectedFingerprint {
		return AttachmentItem{}, errAttachmentChanged
	}
	if before.Size() > s.limits.maxFileBytes {
		return AttachmentItem{}, errAttachmentLimit
	}
	data, err := io.ReadAll(io.LimitReader(file, s.limits.maxFileBytes+1))
	if err != nil || int64(len(data)) > s.limits.maxFileBytes {
		return AttachmentItem{}, errAttachmentChanged
	}
	if err := ctx.Err(); err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || attachmentSourceFingerprint(after) != expectedFingerprint || int64(len(data)) != after.Size() {
		return AttachmentItem{}, errAttachmentChanged
	}
	pathInfo, err := os.Lstat(sourcePath)
	if err != nil || !pathInfo.Mode().IsRegular() || attachmentSourceFingerprint(pathInfo) != expectedFingerprint {
		return AttachmentItem{}, errAttachmentChanged
	}
	return s.Put(ctx, id, paneID, name, "", bytes.NewReader(data), nil)
}

func attachmentSourceFingerprint(info os.FileInfo) string {
	value := fmt.Sprintf("%d:%d:%d:%s", info.Size(), info.Mode(), info.ModTime().UnixNano(), attachmentSourceIdentity(info))
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// Put streams one client file into private staging, validates its bytes,
// then atomically publishes data and metadata as one immutable item. finish
// reads the remaining multipart boundary and rejects any extra parts before
// publication.
func (s *AttachmentStore) Put(ctx context.Context, id, paneID, name, claimedMIME string, input io.Reader, finish func() error) (AttachmentItem, error) {
	stage, existed, err := s.reserveUpload(id, paneID, name)
	if err != nil {
		return AttachmentItem{}, err
	}
	committed := false
	var item AttachmentItem
	var storedBytes int64
	defer func() { s.releaseUpload(id, stage, existed, committed, item, storedBytes) }()

	dataPath := filepath.Join(stage, "data")
	out, err := os.OpenFile(dataPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}
	hash := sha256.New()
	limited := &io.LimitedReader{R: input, N: s.limits.maxFileBytes + 1}
	written, copyErr := io.Copy(io.MultiWriter(out, hash), limited)
	if copyErr != nil {
		_ = out.Close()
		var tooLarge *http.MaxBytesError
		if errors.As(copyErr, &tooLarge) {
			return AttachmentItem{}, errAttachmentLimit
		}
		return AttachmentItem{}, errAttachmentStorage
	}
	if written > s.limits.maxFileBytes {
		_ = out.Close()
		return AttachmentItem{}, errAttachmentLimit
	}
	if err := ctx.Err(); err != nil {
		_ = out.Close()
		return AttachmentItem{}, errAttachmentStorage
	}
	if finish != nil {
		if err := finish(); err != nil {
			_ = out.Close()
			return AttachmentItem{}, err
		}
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return AttachmentItem{}, errAttachmentStorage
	}
	if err := out.Close(); err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}

	kind, mimeType, ext, err := classifyAttachmentFile(dataPath, name, claimedMIME, &s.decodeMu, s.limits.maxImagePixels, s.limits.maxImageDim)
	if err != nil {
		return AttachmentItem{}, err
	}
	stagedData := filepath.Join(stage, "file"+ext)
	if err := os.Rename(dataPath, stagedData); err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}
	finalDir := filepath.Join(s.itemsDir, id)
	finalData := filepath.Join(finalDir, "file"+ext)
	absPath, err := filepath.Abs(finalData)
	if err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}
	item = AttachmentItem{
		ID: id, Name: name, Path: absPath, SizeBytes: written,
		MIMEType: mimeType, Kind: kind, SHA256: hex.EncodeToString(hash.Sum(nil)), PaneID: paneID,
	}
	diskItem := attachmentDiskItem{AttachmentItem: item, PaneID: paneID}
	meta, err := json.Marshal(diskItem)
	if err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}
	if err := writeSyncedFile(filepath.Join(stage, "metadata.json"), meta, 0o600, true); err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}
	if err := syncAttachmentDir(stage); err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}

	if existed {
		prior, getErr := s.getItemOwned(id, paneID)
		if getErr != nil {
			return AttachmentItem{}, getErr
		}
		if prior.Name != name || prior.SizeBytes != written || prior.SHA256 != item.SHA256 {
			return AttachmentItem{}, errAttachmentConflict
		}
		return prior, nil
	}
	if _, err := os.Lstat(finalDir); err == nil {
		return AttachmentItem{}, errAttachmentConflict
	} else if !errors.Is(err, os.ErrNotExist) {
		return AttachmentItem{}, errAttachmentStorage
	}
	if err := os.Rename(stage, finalDir); err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}
	stage = ""
	storedBytes = written + int64(len(meta))
	committed = true
	if err := syncAttachmentDir(s.itemsDir); err != nil {
		return AttachmentItem{}, errAttachmentStorage
	}
	return item, nil
}

func (s *AttachmentStore) getItemOwned(id, paneID string) (AttachmentItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok {
		return AttachmentItem{}, errAttachmentNotFound
	}
	if item.PaneID != paneID {
		return AttachmentItem{}, errAttachmentForbidden
	}
	return item, nil
}

func (s *AttachmentStore) Item(id, paneID string) (AttachmentItem, error) {
	if !canonicalAttachmentUUID(id) || paneID == "" || len(paneID) > 256 {
		return AttachmentItem{}, errAttachmentInvalid
	}
	return s.getItemOwned(id, paneID)
}

// ProcessRoot creates the private handoff root for one provisioned Pi process.
func (s *AttachmentStore) ProcessRoot(processID string) (string, error) {
	if !safeHandoffProcessID(processID) {
		return "", errAttachmentInvalid
	}
	dir := filepath.Join(s.handoffDir, processID)
	if err := ensureAttachmentDir(dir); err != nil {
		return "", errAttachmentStorage
	}
	return filepath.Abs(dir)
}

type AttachmentHandoffRef struct {
	Basename  string `json:"basename"`
	SizeBytes int64  `json:"size_bytes"`
	MIMEType  string `json:"mime_type"`
	Kind      string `json:"kind"`
	SHA256    string `json:"sha256"`
}

// CreateHandoff copies immutable owned items into one process-scoped private
// directory. The generated basename is the only path component sent over IPC.
func (s *AttachmentStore) CreateHandoff(processID, paneID string, ids []string) (string, []AttachmentHandoffRef, error) {
	if len(ids) == 0 || len(ids) > attachmentHandoffMaxRefs || !safeHandoffProcessID(processID) {
		return "", nil, errAttachmentInvalid
	}
	root, err := s.ProcessRoot(processID)
	if err != nil {
		return "", nil, err
	}
	s.mu.Lock()
	if s.closed || s.active >= s.limits.maxActive {
		s.mu.Unlock()
		return "", nil, errAttachmentLimit
	}
	s.active++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.active--
		s.mu.Unlock()
	}()

	refs := make([]AttachmentHandoffRef, 0, len(ids))
	var total int64
	for _, id := range ids {
		item, err := s.Item(id, paneID)
		if err != nil {
			return "", nil, err
		}
		total += item.SizeBytes
		if total > attachmentHandoffMaxTotal {
			return "", nil, errAttachmentLimit
		}
		reserve := item.SizeBytes
		s.mu.Lock()
		if s.usedBytes+s.reserved+reserve > s.limits.maxBytes {
			s.mu.Unlock()
			return "", nil, errAttachmentLimit
		}
		s.reserved += reserve
		s.mu.Unlock()
		ref, copiedBytes, copyErr := s.copyHandoff(root, item)
		s.mu.Lock()
		s.reserved -= reserve
		if copyErr == nil {
			s.usedBytes += copiedBytes
		}
		s.mu.Unlock()
		if copyErr != nil {
			return "", nil, copyErr
		}
		refs = append(refs, ref)
	}
	return root, refs, nil
}

// attachmentHandoffBasename keeps a readable name within the existing ASCII
// bridge boundary. The UUID prefix prevents collisions and reserved filenames.
func attachmentHandoffBasename(id string, item AttachmentItem) string {
	prefix := "att-" + strings.ReplaceAll(id, "-", "") + "-"
	name := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '_'
	}, item.Name)
	name = strings.TrimRight(name, ".")
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if item.Kind == "image" {
		if item.MIMEType == "image/png" {
			ext = ".png"
		} else if item.MIMEType == "image/jpeg" {
			ext = ".jpg"
		}
	}
	budget := attachmentHandoffMaxName - len(prefix) - len(ext)
	if budget < 1 {
		stem, ext = name, ""
		budget = attachmentHandoffMaxName - len(prefix)
	}
	stem = strings.Trim(strings.ReplaceAll(stem, "..", "_"), ".")
	if stem == "" {
		stem = "file"
	}
	stem = strings.TrimRight(stem[:min(len(stem), budget)], ".")
	return prefix + stem + ext
}

func (s *AttachmentStore) copyHandoff(root string, item AttachmentItem) (AttachmentHandoffRef, int64, error) {
	src, err := openAttachmentRegularNoFollow(item.Path)
	if err != nil {
		return AttachmentHandoffRef{}, 0, errAttachmentStorage
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != item.SizeBytes {
		return AttachmentHandoffRef{}, 0, errAttachmentStorage
	}
	id, err := randomAttachmentID()
	if err != nil {
		return AttachmentHandoffRef{}, 0, errAttachmentStorage
	}
	basename := attachmentHandoffBasename(id, item)
	target := filepath.Join(root, basename)
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return AttachmentHandoffRef{}, 0, errAttachmentStorage
	}
	h := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(src, item.SizeBytes+1))
	if copyErr == nil && written == item.SizeBytes && hex.EncodeToString(h.Sum(nil)) == item.SHA256 {
		copyErr = out.Sync()
	} else if copyErr == nil {
		copyErr = errAttachmentConflict
	}
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(target)
		return AttachmentHandoffRef{}, 0, errAttachmentStorage
	}
	if err := syncAttachmentDir(root); err != nil {
		_ = os.Remove(target)
		return AttachmentHandoffRef{}, 0, errAttachmentStorage
	}
	return AttachmentHandoffRef{
		Basename: basename, SizeBytes: item.SizeBytes,
		MIMEType: item.MIMEType, Kind: item.Kind, SHA256: item.SHA256,
	}, item.SizeBytes, nil
}

func (s *AttachmentStore) BeginSend(id, paneID, requestHash string) (attachmentSendRecord, bool, error) {
	if !canonicalAttachmentUUID(id) || paneID == "" || len(paneID) > 256 || requestHash == "" || len(requestHash) != 64 {
		return attachmentSendRecord{}, false, errAttachmentInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return attachmentSendRecord{}, false, errAttachmentStorage
	}
	if record, ok := s.sends[id]; ok {
		if record.PaneID != paneID || record.RequestHash != requestHash {
			return attachmentSendRecord{}, false, errAttachmentConflict
		}
		return record, false, nil
	}
	if s.records+s.reservedRecords >= s.limits.maxRecords || s.usedBytes+s.reserved+1024 > s.limits.maxBytes {
		return attachmentSendRecord{}, false, errAttachmentLimit
	}
	record := attachmentSendRecord{ID: id, PaneID: paneID, RequestHash: requestHash, State: "pending"}
	if err := s.writeSendLocked(record); err != nil {
		return attachmentSendRecord{}, false, errAttachmentStorage
	}
	data, _ := json.Marshal(record)
	s.usedBytes += int64(len(data))
	s.records++
	s.sends[id] = record
	return record, true, nil
}

func (s *AttachmentStore) UpdateSend(id string, attempted bool, state, reason string) error {
	if state != "pending" && state != "refused" && state != "dispatched" && state != "unknown" {
		return errAttachmentInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.sends[id]
	if !ok {
		return errAttachmentNotFound
	}
	oldBytes, _ := json.Marshal(record)
	record.Attempted = record.Attempted || attempted
	record.State = state
	record.Reason = reason
	newBytes, _ := json.Marshal(record)
	if int64(len(newBytes))-int64(len(oldBytes))+s.usedBytes+s.reserved > s.limits.maxBytes {
		return errAttachmentLimit
	}
	if err := s.writeSendLocked(record); err != nil {
		return errAttachmentStorage
	}
	s.usedBytes += int64(len(newBytes)) - int64(len(oldBytes))
	s.sends[id] = record
	return nil
}

func (s *AttachmentStore) Send(id, paneID string) (attachmentSendRecord, error) {
	if !canonicalAttachmentUUID(id) || paneID == "" || len(paneID) > 256 {
		return attachmentSendRecord{}, errAttachmentInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.sends[id]
	if !ok || record.PaneID != paneID {
		return attachmentSendRecord{}, errAttachmentNotFound
	}
	return record, nil
}

func (s *AttachmentStore) writeSendLocked(record attachmentSendRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	final := filepath.Join(s.sendsDir, record.ID+".json")
	tmp, err := os.CreateTemp(s.sendsDir, ".send-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if runtime.GOOS != "windows" {
		if err := tmp.Chmod(0o600); err != nil {
			_ = tmp.Close()
			return err
		}
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, final); err != nil {
		return err
	}
	return syncAttachmentDir(s.sendsDir)
}

func (s *AttachmentStore) usageForTest() (used, reserved int64, records, active int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usedBytes, s.reserved, s.records, s.active
}
