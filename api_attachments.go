package main

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/rpc"
	_ "golang.org/x/image/webp"
)

const (
	attachmentMaxBytes        = 25 << 20
	attachmentMaxPixels       = 16_000_000
	attachmentMaxDecodedBytes = 32 << 20
	attachmentMaxQueueImages  = 4
	attachmentDirMode         = 0o700
	attachmentFileMode        = 0o600
	attachmentProvisionalTTL  = 30 * time.Minute
)

var attachmentMIMEToExt = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

const (
	attachmentLeaseProvisional = "provisional"
	attachmentLeaseClaimed     = "claimed"
)

type attachmentLease struct {
	Owner        string
	Sid          string
	SessionEpoch string
	ItemID       string
	Kind         string
	ExpiresAt    time.Time
}

type attachmentRecord struct {
	Ref       string
	Name      string
	MimeType  string
	SizeBytes int64
	Path      string
	Owner     string
	Lease     *attachmentLease
	Expired   bool
}

type attachmentStore struct {
	mu        sync.Mutex
	cleanupMu sync.Mutex
	records   map[string]*attachmentRecord
}

func newAttachmentStore() *attachmentStore {
	return &attachmentStore{records: make(map[string]*attachmentRecord)}
}

var attachmentState = newAttachmentStore()

// These hooks keep janitor tests deterministic without making production
// cleanup depend on a fixed wall-clock offset.
var (
	attachmentNow         = time.Now
	attachmentRandomDelay = randomAttachmentDelay
)

func attachmentDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".phi", "clipboard")
	}
	return filepath.Join(home, ".phi", "clipboard")
}

func attachmentOwnerForRequest(r *http.Request) (string, error) {
	if !accessAuth.enabled() {
		return "anonymous", nil
	}
	if !accessAuth.authenticated(r) {
		return "", errAccessUnauthorized
	}
	cookie, err := r.Cookie(accessSessionCookie)
	if err != nil || cookie.Value == "" {
		return "", errAccessUnauthorized
	}
	hash := sha256.Sum256([]byte(cookie.Value))
	return hex.EncodeToString(hash[:]), nil
}

func randomAttachmentDelay(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	n, err := cryptorand.Int(cryptorand.Reader, big.NewInt(int64(max)+1))
	if err != nil {
		return 0
	}
	return time.Duration(n.Int64())
}

func ensureAttachmentDir(dir string) error {
	if err := os.MkdirAll(dir, attachmentDirMode); err != nil {
		return err
	}
	// Repair old/broad permissions without making startup depend on a sweep.
	if err := os.Chmod(dir, attachmentDirMode); err != nil {
		return err
	}
	return nil
}

func writeAttachmentBytes(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := ensureAttachmentDir(dir); err != nil {
		return err
	}
	tmp, err := os.OpenFile(path+".tmp-"+randomAttachmentName(8), os.O_WRONLY|os.O_CREATE|os.O_EXCL, attachmentFileMode)
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, attachmentFileMode); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return os.Chmod(path, attachmentFileMode)
}

func randomAttachmentName(bytesCount int) string {
	buf := make([]byte, bytesCount)
	if _, err := cryptorand.Read(buf); err != nil {
		return fmt.Sprintf("%x", attachmentNow().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func randomAttachmentRef() (string, error) {
	buf := make([]byte, 32)
	if _, err := cryptorand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func validAttachmentRef(ref string) bool {
	if len(ref) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(ref)
	return err == nil && len(decoded) == 32
}

func normalizeAttachmentMIME(value string) string {
	return strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
}

func sniffAttachmentMIME(data []byte) string {
	if len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	switch http.DetectContentType(data) {
	case "image/png":
		return "image/png"
	case "image/jpeg":
		return "image/jpeg"
	case "image/gif":
		return "image/gif"
	default:
		return ""
	}
}

func validateAttachmentData(data []byte, declaredMIME string) (int, int, error) {
	if len(data) == 0 {
		return 0, 0, errors.New("image is empty")
	}
	if len(data) > attachmentMaxBytes {
		return 0, 0, fmt.Errorf("image exceeds %d byte limit", attachmentMaxBytes)
	}
	declared := normalizeAttachmentMIME(declaredMIME)
	if _, ok := attachmentMIMEToExt[declared]; !ok {
		return 0, 0, fmt.Errorf("unsupported image MIME type %q", declared)
	}
	actual := sniffAttachmentMIME(data)
	if actual == "" || actual != declared {
		return 0, 0, fmt.Errorf("image MIME does not match declared type")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid image: %w", err)
	}
	if config.Width <= 0 || config.Height <= 0 {
		return 0, 0, errors.New("image dimensions are invalid")
	}
	pixels := uint64(config.Width) * uint64(config.Height)
	if pixels > attachmentMaxPixels {
		return 0, 0, fmt.Errorf("image exceeds %d pixel limit", attachmentMaxPixels)
	}
	if pixels > attachmentMaxDecodedBytes/4 {
		return 0, 0, errors.New("image exceeds decoded memory limit")
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return 0, 0, fmt.Errorf("invalid image data: %w", err)
	}
	return config.Width, config.Height, nil
}

func attachmentServerName(ref, mime string) string {
	return fmt.Sprintf("clip-%s%s", ref[:16], attachmentMIMEToExt[mime])
}

func (s *attachmentStore) upload(owner, mime string, data []byte) (rpc.QueueAttachment, error) {
	ref, err := randomAttachmentRef()
	if err != nil {
		return rpc.QueueAttachment{}, err
	}
	name := attachmentServerName(ref, mime)
	path := filepath.Join(attachmentDir(), name)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := writeAttachmentBytes(path, data); err != nil {
		return rpc.QueueAttachment{}, err
	}
	s.records[ref] = &attachmentRecord{
		Ref:       ref,
		Name:      name,
		MimeType:  mime,
		SizeBytes: int64(len(data)),
		Path:      path,
		Owner:     owner,
		Lease: &attachmentLease{
			Owner:     owner,
			Kind:      attachmentLeaseProvisional,
			ExpiresAt: attachmentNow().Add(attachmentProvisionalTTL),
		},
	}
	return rpc.QueueAttachment{Ref: ref, Name: name, MimeType: mime, SizeBytes: int64(len(data)), Data: append([]byte(nil), data...)}, nil
}

func attachmentRecordMatchesLease(record *attachmentRecord, owner, sid, epoch, itemID, kind string) bool {
	return record != nil && record.Lease != nil && record.Lease.Owner == owner && record.Lease.Sid == sid && record.Lease.SessionEpoch == epoch && record.Lease.ItemID == itemID && record.Lease.Kind == kind
}

func provisionalLeaseExpired(lease *attachmentLease, now time.Time) bool {
	return lease != nil && lease.Kind == attachmentLeaseProvisional && !lease.ExpiresAt.IsZero() && !now.Before(lease.ExpiresAt)
}

// expireProvisionalLocked removes expired reference authority while leaving
// the raw file for the normal retention janitor. This bounds staged-reference
// reuse without changing the approved 30-day file retention policy.
func (s *attachmentStore) expireProvisionalLocked(ref string, now time.Time) bool {
	record := s.records[ref]
	if record == nil || !provisionalLeaseExpired(record.Lease, now) {
		return false
	}
	delete(s.records, ref)
	return true
}

func (s *attachmentStore) ResolveAttachments(ctx context.Context, owner, sid, epoch, itemID string, refs []string) ([]rpc.QueueAttachment, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(refs) > attachmentMaxQueueImages {
		return nil, fmt.Errorf("at most %d images may be queued", attachmentMaxQueueImages)
	}
	if len(refs) == 0 {
		return []rpc.QueueAttachment{}, nil
	}
	seen := make(map[string]struct{}, len(refs))
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]rpc.QueueAttachment, 0, len(refs))
	var decodedBytes uint64
	now := attachmentNow()
	for _, ref := range refs {
		if !validAttachmentRef(ref) {
			return nil, errors.New("attachment reference is invalid")
		}
		if _, exists := seen[ref]; exists {
			return nil, errors.New("attachment references must be unique")
		}
		seen[ref] = struct{}{}
		if s.expireProvisionalLocked(ref, now) {
			return nil, errors.New("attachment provisional lease expired")
		}
		record := s.records[ref]
		if record != nil && record.Expired {
			delete(s.records, ref)
			return nil, errors.New("attachment provisional lease expired")
		}
		if record == nil || record.Owner != owner {
			return nil, errors.New("attachment is unavailable to this client")
		}
		if record.Lease != nil &&
			!(attachmentRecordMatchesLease(record, owner, "", "", "", attachmentLeaseProvisional) || attachmentRecordMatchesLease(record, owner, sid, epoch, itemID, attachmentLeaseClaimed)) {
			return nil, errors.New("attachment is already claimed")
		}
		data, err := os.ReadFile(record.Path)
		if err != nil {
			return nil, errors.New("attachment is unavailable")
		}
		width, height, err := validateAttachmentData(data, record.MimeType)
		if err != nil {
			return nil, err
		}
		imageDecodedBytes := uint64(width) * uint64(height) * 4
		if imageDecodedBytes > attachmentMaxDecodedBytes || decodedBytes > attachmentMaxDecodedBytes-imageDecodedBytes {
			return nil, errors.New("queued image data exceeds decoded input limit")
		}
		decodedBytes += imageDecodedBytes
		out = append(out, rpc.QueueAttachment{Ref: record.Ref, Name: record.Name, MimeType: record.MimeType, SizeBytes: record.SizeBytes, Data: data})
	}
	for _, attachment := range out {
		record := s.records[attachment.Ref]
		record.Lease = &attachmentLease{Owner: owner, Sid: sid, SessionEpoch: epoch, ItemID: itemID, Kind: attachmentLeaseClaimed}
	}
	return out, nil
}

func (s *attachmentStore) ReleaseProvisional(owner, ref string) bool {
	if !validAttachmentRef(ref) {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := attachmentNow()
	if s.expireProvisionalLocked(ref, now) {
		return false
	}
	record := s.records[ref]
	if record != nil && record.Expired {
		delete(s.records, ref)
		return false
	}
	if !attachmentRecordMatchesLease(record, owner, "", "", "", attachmentLeaseProvisional) {
		return false
	}
	record.Lease = nil
	return true
}

func (s *attachmentStore) ReleaseAttachments(_ context.Context, owner, sid, epoch, itemID string, refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ref := range refs {
		if !attachmentRecordMatchesLease(s.records[ref], owner, sid, epoch, itemID, attachmentLeaseClaimed) {
			return errors.New("attachment claim is not owned by this client")
		}
	}
	for _, ref := range refs {
		s.records[ref].Lease = nil
	}
	return nil
}

func (s *attachmentStore) CopyAttachments(ctx context.Context, owner, sid, epoch, sourceItemID string, source []rpc.QueueAttachment) ([]rpc.QueueAttachment, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if owner == "" {
		return nil, errors.New("attachment copy requires an owner")
	}
	if len(source) > attachmentMaxQueueImages {
		return nil, fmt.Errorf("at most %d images may be copied", attachmentMaxQueueImages)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	created := make([]rpc.QueueAttachment, 0, len(source))
	cleanupCreated := func() {
		for _, made := range created {
			if record := s.records[made.Ref]; record != nil {
				_ = os.Remove(record.Path)
			}
			delete(s.records, made.Ref)
		}
	}
	for _, attachment := range source {
		if err := ctx.Err(); err != nil {
			cleanupCreated()
			return nil, err
		}
		// Uncertain queue items retain only bounded in-memory bytes. Their
		// filesystem claim is deliberately released before recovery copy.
		data := append([]byte(nil), attachment.Data...)
		if len(data) == 0 {
			cleanupCreated()
			return nil, errors.New("uncertain attachment bytes are unavailable")
		}
		if _, _, err := validateAttachmentData(data, attachment.MimeType); err != nil {
			cleanupCreated()
			return nil, err
		}
		ref, err := randomAttachmentRef()
		if err != nil {
			cleanupCreated()
			return nil, err
		}
		name := attachmentServerName(ref, attachment.MimeType)
		path := filepath.Join(attachmentDir(), name)
		if err := writeAttachmentBytes(path, data); err != nil {
			cleanupCreated()
			return nil, err
		}
		copy := rpc.QueueAttachment{Ref: ref, Name: name, MimeType: attachment.MimeType, SizeBytes: int64(len(data)), Data: data}
		s.records[ref] = &attachmentRecord{
			Ref: ref, Name: name, MimeType: attachment.MimeType,
			SizeBytes: int64(len(data)), Path: path, Owner: owner,
			Lease: &attachmentLease{Owner: owner, Kind: attachmentLeaseProvisional, ExpiresAt: attachmentNow().Add(attachmentProvisionalTTL)},
		}
		created = append(created, copy)
	}
	return created, nil
}

type attachmentCleanupCounts struct {
	RemovedFiles       int
	RemovedBytes       int64
	SkippedLeasedFiles int
	SkippedLeasedBytes int64
	FailedFiles        int
	FailedBytes        int64
}

func (s *attachmentStore) cleanup(cfg Config, force bool, owners ...string) attachmentCleanupCounts {
	var counts attachmentCleanupCounts
	clearOwner := ""
	if len(owners) > 0 {
		clearOwner = owners[0]
	}
	now := attachmentNow()
	if !s.cleanupMu.TryLock() {
		return counts
	}
	defer s.cleanupMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ensureAttachmentDir(attachmentDir()); err != nil {
		return counts
	}
	entries, err := os.ReadDir(attachmentDir())
	if err != nil {
		return counts
	}
	type candidate struct {
		path string
		ref  string
		info os.FileInfo
	}
	candidates := make([]candidate, 0, len(entries))
	leased := make([]candidate, 0)
	byPath := make(map[string]*attachmentRecord, len(s.records))
	for ref, record := range s.records {
		byPath[record.Path] = record
		if _, err := os.Stat(record.Path); errors.Is(err, os.ErrNotExist) {
			delete(s.records, ref)
		}
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(attachmentDir(), entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		_ = os.Chmod(path, attachmentFileMode)
		record := byPath[path]
		if record != nil {
			if clearOwner != "" && record.Owner != clearOwner {
				continue
			}
			if provisionalLeaseExpired(record.Lease, now) {
				// Expire only the provisional authority here. The file remains
				// an ordinary unleased cache entry and is still governed by the
				// configured retention age/cap.
				record.Lease = nil
				record.Expired = true
			}
			if record.Lease != nil {
				leased = append(leased, candidate{path: path, ref: record.Ref, info: info})
				continue
			}
		}
		if record == nil && clearOwner != "" {
			continue
		}
		ref := ""
		if record != nil {
			ref = record.Ref
		}
		candidates = append(candidates, candidate{path: path, ref: ref, info: info})
	}
	if force {
		counts.SkippedLeasedFiles = len(leased)
		for _, item := range leased {
			counts.SkippedLeasedBytes += item.info.Size()
		}
	}
	remove := make(map[string]bool)
	if force {
		for _, item := range candidates {
			remove[item.path] = true
		}
	} else {
		if cfg.AttachmentRetentionAgeSeconds > 0 {
			age := time.Duration(cfg.AttachmentRetentionAgeSeconds) * time.Second
			for _, item := range candidates {
				if now.Sub(item.info.ModTime()) >= age {
					remove[item.path] = true
				}
			}
		}
		if cfg.AttachmentUnleasedFileCap > 0 && len(candidates) > cfg.AttachmentUnleasedFileCap {
			sort.SliceStable(candidates, func(left, right int) bool {
				return candidates[left].info.ModTime().After(candidates[right].info.ModTime())
			})
			for _, item := range candidates[cfg.AttachmentUnleasedFileCap:] {
				remove[item.path] = true
			}
		}
	}
	for _, item := range candidates {
		if !remove[item.path] {
			continue
		}
		if err := os.Remove(item.path); err != nil {
			counts.FailedFiles++
			counts.FailedBytes += item.info.Size()
			continue
		}
		counts.RemovedFiles++
		counts.RemovedBytes += item.info.Size()
		if item.ref != "" {
			delete(s.records, item.ref)
		}
	}
	return counts
}

func runAttachmentCleanup(force bool, owner ...string) attachmentCleanupCounts {
	return attachmentState.cleanup(loadConfig(), force, owner...)
}

func startAttachmentJanitor(ctx context.Context) context.CancelFunc {
	janitorCtx, cancel := context.WithCancel(ctx)
	go func() {
		timer := time.NewTimer(attachmentRandomDelay(60 * time.Second))
		defer timer.Stop()
		select {
		case <-janitorCtx.Done():
			return
		case <-timer.C:
		}
		for {
			runAttachmentCleanup(false)
			interval := time.Duration(loadConfig().AttachmentJanitorIntervalSeconds) * time.Second
			timer.Reset(interval + attachmentRandomDelay(60*time.Second))
			select {
			case <-janitorCtx.Done():
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				return
			case <-timer.C:
			}
		}
	}()
	return cancel
}

func handleAttachments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	owner, err := attachmentOwnerForRequest(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, attachmentMaxBytes+1024)
	if err := r.ParseMultipartForm(attachmentMaxBytes); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			http.Error(w, "Attachment too large (max 25 MB)", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "Invalid multipart body: "+err.Error(), http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Missing 'file' field: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()
	mimeType := normalizeAttachmentMIME(header.Header.Get("Content-Type"))
	if _, ok := attachmentMIMEToExt[mimeType]; !ok {
		http.Error(w, "Unsupported file type: "+mimeType, http.StatusBadRequest)
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, attachmentMaxBytes+1))
	if err != nil {
		http.Error(w, "Failed to read upload", http.StatusBadRequest)
		return
	}
	if int64(len(data)) > attachmentMaxBytes {
		http.Error(w, "Attachment too large (max 25 MB)", http.StatusRequestEntityTooLarge)
		return
	}
	if _, _, err := validateAttachmentData(data, mimeType); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	attachment, err := attachmentState.upload(owner, mimeType, data)
	if err != nil {
		http.Error(w, "Failed to write attachment", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ref": attachment.Ref, "name": attachment.Name,
		"sizeBytes": attachment.SizeBytes, "mimeType": attachment.MimeType,
	})
}

func handleAttachmentRelease(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	owner, err := attachmentOwnerForRequest(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	var req struct {
		Ref string `json:"ref"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil || !validAttachmentRef(req.Ref) {
		http.Error(w, "ref is required", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"released": attachmentState.ReleaseProvisional(owner, req.Ref)})
}

func handleAttachmentClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	owner, err := attachmentOwnerForRequest(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	counts := runAttachmentCleanup(true, owner)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"removed":       map[string]any{"files": counts.RemovedFiles, "bytes": counts.RemovedBytes},
		"skippedLeased": map[string]any{"files": counts.SkippedLeasedFiles, "bytes": counts.SkippedLeasedBytes},
		"failed":        map[string]any{"files": counts.FailedFiles, "bytes": counts.FailedBytes},
	})
}

// Ensure the RPC package sees the resolver methods implemented by the store.
var _ rpc.QueueAttachmentResolver = (*attachmentStore)(nil)
