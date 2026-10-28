package main

import (
	"bytes"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/ws"
)

const (
	accessPasswordHashVersion    = "v1"
	accessPasswordHashAlgorithm  = "pbkdf2-sha256"
	accessPasswordHashIterations = 600000
	accessPasswordMinIterations  = 100000
	accessPasswordMaxIterations  = 10000000
	accessPasswordSaltBytes      = 16
	accessPasswordVerifierBytes  = 32
	accessChallengeTTL           = 5 * time.Minute
	accessSessionTTL             = 100 * 365 * 24 * time.Hour
	accessSessionCookie          = "phi_access_session"
	maxAccessChallenges          = 1024
	accessJWTAlgorithm           = "HS256"
	accessJWTProtocol            = "v2"
	accessJWTType                = "JWT"
	accessJWTIssuer              = "phi"
	accessJWTKeyBytes            = 32
	accessJWTNonceBytes          = 32
	accessJWTInfo                = "phi/access-jwt/v1"
	accessJWTLifetime            = time.Hour
	accessJWTMaxLifetime         = time.Hour
	accessJWTClockAllowance      = 30 * time.Second
	accessPasswordMinBytes       = 8
	accessPasswordMaxBytes       = 1024
	accessPasswordBodyLimit      = 8192

	// v2 credential carriers. The refresh handle is reachable only from the
	// refresh route's own path, and the asset cookie only from the two asset
	// reads: neither is a session cookie.
	accessRefreshCookie     = "phi_access_refresh"
	accessAssetCookie       = "phi_access_asset"
	accessRefreshCookiePath = "/api/auth/v2/refresh"
	accessAssetCookiePath   = "/api"
	accessAssetFilePath     = "/api/file/asset"
	accessAssetMarkdownPath = "/api/markdown/asset"

	// v2 session state. The file is a read-modify-write record whose content
	// decides revocation, so exactly one process may own it.
	accessV2StateVersion     = 1
	accessV2StateFileName    = "auth-v2-state.json"
	accessV2LockFileName     = ".auth-v2-state.lock"
	accessRefreshIdle        = 30 * 24 * time.Hour
	accessRefreshAbsolute    = 90 * 24 * time.Hour
	accessRefreshGrace       = 60 * time.Second
	accessConsumedRetention  = 7 * 24 * time.Hour
	maxAccessFamilies        = 1024
	maxAccessConsumedPerFam  = 256
	maxAccessV2StateBytes    = 64 << 20
	accessRefreshKeyBytes    = 32
	accessRefreshHandleBytes = 32
	accessRefreshKeyInfo     = "phi/refresh-handle/v1"
	accessRefreshBodyLimit   = 1024

	// Refresh has its own abuse budget: a tab storm must never touch the
	// shared password-login backoff.
	accessRefreshBurst      = 20
	accessRefreshPerMinute  = 120
	maxAccessRefreshBuckets = 4096
	accessRefreshBucketIdle = 15 * time.Minute

	// The v2 POST routes require this non-secret header, so a cross-origin
	// HTML form cannot reach them without a preflight.
	accessV2Header      = "X-Phi-Auth"
	accessV2HeaderValue = "v2"
)

var (
	errAccessUnauthorized = errors.New("access authentication required")
	errAccessRateLimited  = errors.New("too many failed password attempts; try again shortly")
	errAccessJWTInvalid   = errors.New("invalid access token")
	errAccessPersistence  = errors.New("unable to persist access password")
	errAccessNotEnabled   = errors.New("access password is not enabled")
	errAccessRefreshLimit = errors.New("too many refresh requests")
	errAccessForbidden    = errors.New("forbidden")
)

type accessPasswordRecord struct {
	Iterations int
	Salt       []byte
	Verifier   []byte
}

func (r accessPasswordRecord) encoded() string {
	return strings.Join([]string{
		accessPasswordHashVersion,
		accessPasswordHashAlgorithm,
		strconv.Itoa(r.Iterations),
		base64.RawURLEncoding.EncodeToString(r.Salt),
		base64.RawURLEncoding.EncodeToString(r.Verifier),
	}, ".")
}

// parseAccessPasswordHash accepts the only verifier format Phi writes. The
// browser derives the verifier; Phi stores it without ever receiving the raw
// password. The salt and work factor are public KDF parameters, while the
// derived verifier remains secret and is never returned by an API.
func parseAccessPasswordHash(encoded string) (*accessPasswordRecord, error) {
	if encoded == "" {
		return nil, nil
	}
	parts := strings.Split(encoded, ".")
	if len(parts) != 5 || parts[0] != accessPasswordHashVersion || parts[1] != accessPasswordHashAlgorithm {
		return nil, errors.New("invalid access password hash format")
	}
	iterations, err := strconv.Atoi(parts[2])
	if err != nil || iterations < accessPasswordMinIterations || iterations > accessPasswordMaxIterations {
		return nil, errors.New("unsupported access password hash parameters")
	}
	salt, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(salt) != accessPasswordSaltBytes {
		return nil, errors.New("invalid access password hash salt")
	}
	verifier, err := base64.RawURLEncoding.DecodeString(parts[4])
	if err != nil || len(verifier) != accessPasswordVerifierBytes {
		return nil, errors.New("invalid access password hash verifier")
	}
	return &accessPasswordRecord{Iterations: iterations, Salt: salt, Verifier: verifier}, nil
}

// deriveAccessVerifier runs PBKDF2-SHA256 at the record's own iteration count.
func deriveAccessVerifier(password string, salt []byte, iterations int) ([]byte, error) {
	return pbkdf2.Key(sha256.New, password, salt, iterations, accessPasswordVerifierBytes)
}

// newAccessPasswordRecord builds a record at the current parameters from a raw
// password. The salt is fresh, so an identical password yields a new verifier.
func newAccessPasswordRecord(password string) (*accessPasswordRecord, error) {
	salt := make([]byte, accessPasswordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	verifier, err := deriveAccessVerifier(password, salt, accessPasswordHashIterations)
	if err != nil {
		return nil, err
	}
	return &accessPasswordRecord{Iterations: accessPasswordHashIterations, Salt: salt, Verifier: verifier}, nil
}

// matchesPassword compares a raw password with the stored verifier at the
// record's iteration count in constant time.
func (r accessPasswordRecord) matchesPassword(password string) (bool, error) {
	candidate, err := deriveAccessVerifier(password, r.Salt, r.Iterations)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(candidate, r.Verifier) == 1, nil
}

// rehashed returns a replacement record when the stored work factor is stale,
// so a successful password login can upgrade it without a separate migration.
func (r accessPasswordRecord) rehashed(password string) (*accessPasswordRecord, bool, error) {
	if r.Iterations == accessPasswordHashIterations {
		return nil, false, nil
	}
	record, err := newAccessPasswordRecord(password)
	if err != nil {
		return nil, false, err
	}
	return record, true, nil
}

// accessJWTKey derives the HS256 signing key from the stored verifier, so a
// record change rotates every outstanding token without extra state.
func accessJWTKey(record *accessPasswordRecord) ([]byte, error) {
	if record == nil {
		return nil, nil
	}
	return hkdf.Key(sha256.New, record.Verifier, record.Salt, accessJWTInfo, accessJWTKeyBytes)
}

type accessJWTHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
}

type accessJWTPayload struct {
	Issuer    string `json:"iss"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	Nonce     string `json:"jti"`
	RecordID  string `json:"rid"`
	Epoch     uint64 `json:"epoch"`
	FamilyID  string `json:"fid"`
}

// accessJWTRevocation is the record identity, epoch, and family a token is
// bound to. A token outlives neither a new record identity nor a retired
// family, whatever its expiry says.
type accessJWTRevocation struct {
	RecordID string
	Epoch    uint64
	FamilyID string
}

// accessJWTClaims is the verified content of a v2 access token.
type accessJWTClaims struct {
	IssuedAt  time.Time
	ExpiresAt time.Time
	Nonce     string
	RecordID  string
	Epoch     uint64
	FamilyID  string
}

// --- v2 session state ----------------------------------------------------

// accessV2Access is the access-token metadata a family currently serves. It is
// persisted so a lost refresh response can be replayed with identical bytes,
// including the same JTI, even across a restart.
type accessV2Access struct {
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	Nonce     string `json:"jti"`
}

// accessV2Consumed is one retired handle digest, kept as replay evidence until
// it is old enough that the family it belonged to can no longer be identified.
type accessV2Consumed struct {
	Digest     string `json:"digest"`
	ConsumedAt int64  `json:"consumed_at"`
}

// accessV2Family is one login: a rotating refresh-handle chain plus the access
// token it backs. Handles themselves are never stored, only digests.
type accessV2Family struct {
	ID                string             `json:"id"`
	Generation        uint64             `json:"generation"`
	CreatedAt         int64              `json:"created_at"`
	LastUsedAt        int64              `json:"last_used_at"`
	IdleExpiresAt     int64              `json:"idle_expires_at"`
	AbsoluteExpiresAt int64              `json:"absolute_expires_at"`
	ActiveDigest      string             `json:"active_digest"`
	CurrentAccess     accessV2Access     `json:"current_access"`
	Consumed          []accessV2Consumed `json:"consumed"`
}

// accessV2ActiveState is the durable identity every access token is checked
// against, together with the families that may authorize.
type accessV2ActiveState struct {
	RecordBinding string           `json:"record_binding"`
	RecordID      string           `json:"record_id"`
	Epoch         uint64           `json:"epoch"`
	RefreshKey    *string          `json:"refresh_key"`
	Families      []accessV2Family `json:"families"`
}

// accessV2Pending is the password-change journal: the candidate record plus the
// state that becomes active once Config carries that record. Exactly one entry
// exists while a change is in flight.
type accessV2Pending struct {
	FromRecordBinding string              `json:"from_record_binding"`
	PasswordRecord    string              `json:"password_record"`
	Next              accessV2ActiveState `json:"next"`
}

type accessV2StateFile struct {
	Version int                 `json:"version"`
	Active  accessV2ActiveState `json:"active"`
	Pending *accessV2Pending    `json:"pending"`
}

// accessV2ConsumedRef locates the family that retired a handle digest.
type accessV2ConsumedRef struct {
	FamilyID   string
	ConsumedAt time.Time
}

// accessV2Runtime is active state in memory: the same data plus bounded digest
// indexes, so authorization is one map lookup instead of a scan.
type accessV2Runtime struct {
	recordBinding string
	recordID      string
	epoch         uint64
	refreshKey    []byte
	families      map[string]*accessV2Family
	active        map[string]string
	consumed      map[string]accessV2ConsumedRef
}

func newAccessV2Runtime() accessV2Runtime {
	return accessV2Runtime{
		families: make(map[string]*accessV2Family),
		active:   make(map[string]string),
		consumed: make(map[string]accessV2ConsumedRef),
	}
}

// accessRecordBinding fingerprints the encoded password record. A record edit
// therefore mismatches the state file even when the password is unchanged.
func accessRecordBinding(encoded string) string {
	sum := sha256.Sum256([]byte(encoded))
	return hex.EncodeToString(sum[:])
}

// accessRefreshKey derives the handle-reconstruction key for a record. It is
// separate from the signing key so a leaked access token cannot mint handles.
func accessRefreshKey(record *accessPasswordRecord) ([]byte, error) {
	if record == nil {
		return nil, nil
	}
	return hkdf.Key(sha256.New, record.Verifier, record.Salt, accessRefreshKeyInfo, accessRefreshKeyBytes)
}

// accessRefreshHandle derives the opaque handle for one family generation. A
// random family ID keeps the value unguessable; the key makes it reproducible
// after a restart, which is what makes an interrupted rotation recoverable.
func accessRefreshHandle(key []byte, familyID string, generation uint64) (string, error) {
	if len(key) != accessRefreshKeyBytes {
		return "", errors.New("missing refresh key")
	}
	id, err := base64.RawURLEncoding.DecodeString(familyID)
	if err != nil || len(id) != accessRefreshHandleBytes {
		return "", errors.New("invalid family id")
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(accessRefreshKeyInfo))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write(id)
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], generation)
	_, _ = mac.Write(counter[:])
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// accessHandleDigest is the stored form of a presented handle. Only this digest
// reaches durable state.
func accessHandleDigest(handle string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(handle)
	if err != nil || len(raw) != accessRefreshHandleBytes {
		return "", errors.New("invalid refresh handle")
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func validAccessDigest(digest string) bool {
	if len(digest) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(digest)
	return err == nil
}

// accessV2StatePath keeps session state beside the config file, so a test that
// isolates the config directory also isolates the state file.
func accessV2StatePath() string {
	return filepath.Join(filepath.Dir(configFilePath()), accessV2StateFileName)
}

// accessV2LockPath is a stable inode: locking the state file itself would be
// useless because every write replaces it atomically.
func accessV2LockPath() string {
	return filepath.Join(filepath.Dir(configFilePath()), accessV2LockFileName)
}

// writeAccessV2StateFile is the strict state writer. Tests replace it to inject
// persistence failures between the journal and the commit point.
var writeAccessV2StateFile = system.WriteFileAtomicPreserveExisting

// accessStateLock owns the on-disk auth state for this process.
type accessStateLock struct {
	file *os.File
}

// tryAcquire attempts the exclusive lock once. It is deliberately
// non-blocking: a second instance must learn immediately that it may not
// authorize anything, and may retry later when the first exits.
func (l *accessStateLock) tryAcquire(path string) bool {
	if l.file != nil {
		return true
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return false
	}
	if err := lockAuthStateFile(file); err != nil {
		_ = file.Close()
		return false
	}
	l.file = file
	return true
}

func (l *accessStateLock) held() bool {
	return l.file != nil
}

func (l *accessStateLock) release() {
	if l.file == nil {
		return
	}
	_ = unlockAuthStateFile(l.file)
	_ = l.file.Close()
	l.file = nil
}

// loadAccessV2StateFile reads and validates durable state. A missing or empty
// file is not an error: first run has no state yet. Anything else that cannot
// be trusted is an error, because guessing would resurrect revoked sessions.
func loadAccessV2StateFile(path string) (*accessV2StateFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "" {
		return nil, nil
	}
	if len(raw) > maxAccessV2StateBytes {
		return nil, errors.New("access state exceeds the size bound")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var state accessV2StateFile
	if err := decoder.Decode(&state); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, errors.New("access state has trailing data")
	}
	if state.Version != accessV2StateVersion {
		return nil, errors.New("unsupported access state version")
	}
	if err := validateAccessV2Active(&state.Active); err != nil {
		return nil, err
	}
	if state.Pending != nil {
		if err := validateAccessV2Active(&state.Pending.Next); err != nil {
			return nil, err
		}
		if !validAccessBinding(state.Pending.FromRecordBinding) {
			return nil, errors.New("invalid pending journal binding")
		}
		if _, err := parseAccessPasswordHash(state.Pending.PasswordRecord); err != nil {
			return nil, err
		}
	}
	return &state, nil
}

func validAccessBinding(binding string) bool {
	if len(binding) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(binding)
	return err == nil
}

// validateAccessV2Active enforces the schema, bounds, and deadline
// relationships on load, so a hand-edited or truncated file cannot authorize
// more than a fresh login would.
func validateAccessV2Active(active *accessV2ActiveState) error {
	if !validAccessBinding(active.RecordBinding) {
		return errors.New("invalid record binding")
	}
	if active.Epoch == 0 {
		return errors.New("invalid epoch")
	}
	if active.RecordID != "" && !validAccessJWTHandle(active.RecordID) {
		return errors.New("invalid record id")
	}
	if active.RefreshKey != nil {
		key, err := base64.RawURLEncoding.DecodeString(*active.RefreshKey)
		if err != nil || len(key) != accessRefreshKeyBytes {
			return errors.New("invalid refresh key")
		}
	}
	if len(active.Families) > maxAccessFamilies {
		return errors.New("too many access families")
	}
	seenFamily := make(map[string]bool, len(active.Families))
	seenDigest := make(map[string]bool, len(active.Families))
	for i := range active.Families {
		family := &active.Families[i]
		if !validAccessJWTHandle(family.ID) {
			return errors.New("invalid family id")
		}
		if seenFamily[family.ID] {
			return errors.New("duplicate family id")
		}
		seenFamily[family.ID] = true
		if family.CreatedAt <= 0 || family.LastUsedAt < family.CreatedAt {
			return errors.New("invalid family timestamps")
		}
		if family.IdleExpiresAt <= family.CreatedAt || family.AbsoluteExpiresAt < family.IdleExpiresAt {
			return errors.New("invalid family deadlines")
		}
		if !validAccessDigest(family.ActiveDigest) || seenDigest[family.ActiveDigest] {
			return errors.New("invalid active digest")
		}
		seenDigest[family.ActiveDigest] = true
		if !validAccessJWTHandle(family.CurrentAccess.Nonce) {
			return errors.New("invalid access nonce")
		}
		if family.CurrentAccess.IssuedAt <= 0 || family.CurrentAccess.ExpiresAt <= family.CurrentAccess.IssuedAt {
			return errors.New("invalid access timestamps")
		}
		if family.CurrentAccess.ExpiresAt-family.CurrentAccess.IssuedAt > int64(accessJWTMaxLifetime/time.Second) {
			return errors.New("access token lifetime exceeds the maximum")
		}
		if len(family.Consumed) > maxAccessConsumedPerFam {
			return errors.New("too many consumed handles")
		}
		for _, consumed := range family.Consumed {
			if !validAccessDigest(consumed.Digest) || seenDigest[consumed.Digest] {
				return errors.New("invalid consumed digest")
			}
			seenDigest[consumed.Digest] = true
			if consumed.ConsumedAt <= 0 {
				return errors.New("invalid consumed timestamp")
			}
		}
	}
	return nil
}

// validAccessJWTHandle reports whether encoded is one canonical 32-byte id.
func validAccessJWTHandle(encoded string) bool {
	return validAccessJWTID(encoded)
}

// saveAccessV2StateFile writes the whole state in one strict replacement. The
// caller holds the manager lock and owns the state directory.
func saveAccessV2StateFile(path string, state *accessV2StateFile) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(data) > maxAccessV2StateBytes {
		return errors.New("access state exceeds the size bound")
	}
	return writeAccessV2StateFile(path, data, 0o600)
}

// loadRuntimeLocked validates active state into the in-memory runtime and
// rebuilds the digest indexes from it.
func (m *accessAuthManager) loadRuntimeLocked(active *accessV2ActiveState) error {
	if err := validateAccessV2Active(active); err != nil {
		return err
	}
	runtime := newAccessV2Runtime()
	runtime.recordBinding = active.RecordBinding
	runtime.recordID = active.RecordID
	runtime.epoch = active.Epoch
	if active.RefreshKey != nil {
		key, err := base64.RawURLEncoding.DecodeString(*active.RefreshKey)
		if err != nil {
			return err
		}
		runtime.refreshKey = key
	}
	for i := range active.Families {
		family := active.Families[i]
		if len(runtime.refreshKey) == accessRefreshKeyBytes {
			// The stored digest must be the handle this state actually
			// derives, otherwise a hand-edited file could point a family at a
			// handle its owner never saw.
			handle, err := accessRefreshHandle(runtime.refreshKey, family.ID, family.Generation)
			if err != nil {
				return err
			}
			digest, err := accessHandleDigest(handle)
			if err != nil {
				return err
			}
			if digest != family.ActiveDigest {
				return errors.New("active digest does not match its handle")
			}
		}
		runtime.families[family.ID] = &family
		runtime.active[family.ActiveDigest] = family.ID
		for _, consumed := range family.Consumed {
			runtime.consumed[consumed.Digest] = accessV2ConsumedRef{
				FamilyID:   family.ID,
				ConsumedAt: time.Unix(consumed.ConsumedAt, 0),
			}
		}
	}
	m.v2 = runtime
	return nil
}

// snapshotLocked renders runtime state as the persisted form, with families
// ordered by ID so an unchanged state marshals to the same bytes.
func (m *accessAuthManager) snapshotLocked() *accessV2ActiveState {
	active := &accessV2ActiveState{
		RecordBinding: m.v2.recordBinding,
		RecordID:      m.v2.recordID,
		Epoch:         m.v2.epoch,
		Families:      make([]accessV2Family, 0, len(m.v2.families)),
	}
	if len(m.v2.refreshKey) == accessRefreshKeyBytes {
		key := base64.RawURLEncoding.EncodeToString(m.v2.refreshKey)
		active.RefreshKey = &key
	}
	ids := make([]string, 0, len(m.v2.families))
	for id := range m.v2.families {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		family := *m.v2.families[id]
		family.Consumed = append([]accessV2Consumed(nil), m.v2.families[id].Consumed...)
		active.Families = append(active.Families, family)
	}
	return active
}

// persistLocked writes the current state. Callers hold the lock and have
// already prepared everything fallible, so a failure here means nothing was
// announced.
func (m *accessAuthManager) persistLocked() error {
	if !m.owned {
		return errAccessPersistence
	}
	return saveAccessV2StateFile(accessV2StatePath(), &accessV2StateFile{
		Version: accessV2StateVersion,
		Active:  *m.snapshotLocked(),
	})
}

// formatAccessJWT signs explicit claims. Production callers use mintAccessJWT,
// which supplies a random nonce; tests use this form for fixed vectors.
func formatAccessJWT(key []byte, issuedAt, expiresAt int64, nonce string, revocation accessJWTRevocation) (string, error) {
	header, err := json.Marshal(accessJWTHeader{Algorithm: accessJWTAlgorithm, Type: accessJWTType})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(accessJWTPayload{
		Issuer:    accessJWTIssuer,
		IssuedAt:  issuedAt,
		ExpiresAt: expiresAt,
		Nonce:     nonce,
		RecordID:  revocation.RecordID,
		Epoch:     revocation.Epoch,
		FamilyID:  revocation.FamilyID,
	})
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func mintAccessJWT(key []byte, now time.Time, revocation accessJWTRevocation) (string, error) {
	nonce := make([]byte, accessJWTNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return formatAccessJWT(key, now.Unix(), now.Add(accessJWTLifetime).Unix(), base64.RawURLEncoding.EncodeToString(nonce), revocation)
}

// parseAccessJWT verifies the signature first, then enforces the exact header
// and payload shape. Every failure returns the same error so callers cannot
// distinguish a malformed token from a forged one. expiryAllowance widens only
// the expiry comparison, so a browser request tolerates clock drift while a
// socket still closes at exp.
func parseAccessJWT(key []byte, token string, now time.Time, expiryAllowance time.Duration) (*accessJWTClaims, error) {
	if len(key) != accessJWTKeyBytes {
		return nil, errAccessJWTInvalid
	}
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		return nil, errAccessJWTInvalid
	}
	header, err := decodeAccessJWTSegment(segments[0])
	if err != nil {
		return nil, errAccessJWTInvalid
	}
	payload, err := decodeAccessJWTSegment(segments[1])
	if err != nil {
		return nil, errAccessJWTInvalid
	}
	signature, err := decodeAccessJWTSegment(segments[2])
	if err != nil || len(signature) != sha256.Size {
		return nil, errAccessJWTInvalid
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(segments[0] + "." + segments[1]))
	if subtle.ConstantTimeCompare(signature, mac.Sum(nil)) != 1 {
		return nil, errAccessJWTInvalid
	}

	headerMembers, err := scanAccessJSONObject(header)
	if err != nil || !accessJWTHasExactKeys(headerMembers, "alg", "typ") {
		return nil, errAccessJWTInvalid
	}
	var verifiedHeader accessJWTHeader
	if err := json.Unmarshal(header, &verifiedHeader); err != nil {
		return nil, errAccessJWTInvalid
	}
	if verifiedHeader.Algorithm != accessJWTAlgorithm || verifiedHeader.Type != accessJWTType {
		return nil, errAccessJWTInvalid
	}

	payloadMembers, err := scanAccessJSONObject(payload)
	if err != nil || !accessJWTHasExactKeys(payloadMembers, "iss", "iat", "exp", "jti", "rid", "epoch", "fid") {
		return nil, errAccessJWTInvalid
	}
	// null leaves a plain int64 at zero, so decode the timestamps through
	// pointers and require both to be present as integers.
	var claims struct {
		Issuer    string `json:"iss"`
		IssuedAt  *int64 `json:"iat"`
		ExpiresAt *int64 `json:"exp"`
		Nonce     string `json:"jti"`
		RecordID  string `json:"rid"`
		FamilyID  string `json:"fid"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.IssuedAt == nil || claims.ExpiresAt == nil {
		return nil, errAccessJWTInvalid
	}
	if claims.Issuer != accessJWTIssuer {
		return nil, errAccessJWTInvalid
	}
	nonce, err := decodeAccessJWTSegment(claims.Nonce)
	if err != nil || len(nonce) != accessJWTNonceBytes {
		return nil, errAccessJWTInvalid
	}
	if !validAccessJWTID(claims.RecordID) || !validAccessJWTID(claims.FamilyID) {
		return nil, errAccessJWTInvalid
	}
	// Parse the raw claim text, not a decoded value: a quoted number, a
	// fraction, or an exponent must fail rather than round into an integer.
	epoch, err := strconv.ParseUint(string(payloadMembers["epoch"]), 10, 64)
	if err != nil || epoch == 0 {
		return nil, errAccessJWTInvalid
	}
	issuedAt, expiresAt := *claims.IssuedAt, *claims.ExpiresAt
	// Positive integers keep the lifetime subtraction from overflowing.
	if issuedAt <= 0 || expiresAt <= 0 || expiresAt <= issuedAt {
		return nil, errAccessJWTInvalid
	}
	if expiresAt-issuedAt > int64(accessJWTMaxLifetime/time.Second) {
		return nil, errAccessJWTInvalid
	}
	if issuedAt > now.Add(accessJWTClockAllowance).Unix() {
		return nil, errAccessJWTInvalid
	}
	expiry := time.Unix(expiresAt, 0)
	if !expiry.Add(expiryAllowance).After(now) {
		return nil, errAccessJWTInvalid
	}
	return &accessJWTClaims{
		IssuedAt:  time.Unix(issuedAt, 0),
		ExpiresAt: expiry,
		Nonce:     claims.Nonce,
		RecordID:  claims.RecordID,
		Epoch:     epoch,
		FamilyID:  claims.FamilyID,
	}, nil
}

// validAccessJWTID accepts only the canonical 32-byte base64url form the
// server writes, so one identity cannot be spelled two ways.
func validAccessJWTID(encoded string) bool {
	decoded, err := decodeAccessJWTSegment(encoded)
	return err == nil && len(decoded) == accessJWTNonceBytes
}

// decodeAccessJWTSegment rejects noncanonical base64url so one token cannot be
// spelled two ways.
func decodeAccessJWTSegment(segment string) ([]byte, error) {
	if segment == "" {
		return nil, errAccessJWTInvalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != segment {
		return nil, errAccessJWTInvalid
	}
	return decoded, nil
}

// scanAccessJSONObject decodes one JSON object and rejects duplicate keys,
// non-string keys, and trailing values. Unmarshalling into a map would keep the
// last duplicate silently.
func scanAccessJSONObject(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errAccessJWTInvalid
	}
	members := make(map[string]json.RawMessage, 4)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errAccessJWTInvalid
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errAccessJWTInvalid
		}
		if _, duplicate := members[key]; duplicate {
			return nil, errAccessJWTInvalid
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errAccessJWTInvalid
		}
		members[key] = value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, errAccessJWTInvalid
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errAccessJWTInvalid
	}
	return members, nil
}

func accessJWTHasExactKeys(members map[string]json.RawMessage, keys ...string) bool {
	if len(members) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := members[key]; !ok {
			return false
		}
	}
	return true
}

// accessCredentialState records whether a request carries a usable explicit v2
// credential, carries one that cannot be used here, or carries none.
type accessCredentialState int

const (
	accessCredentialNone accessCredentialState = iota
	accessCredentialPresent
	accessCredentialInvalid
)

// accessCredential is the raw credential material of one request. It is
// captured before taking the auth mutex and re-evaluated under it, so a record
// change between middleware and handler cannot reuse a stale decision.
type accessCredential struct {
	State  accessCredentialState
	Token  string
	Cookie string
	// Asset is the phi_access_asset cookie. It is usable only on the two asset
	// reads the contract names, and it is never a session cookie.
	Asset      string
	AssetState accessCredentialState
}

// accessAssetRequest reports whether this request may use the asset cookie:
// exactly GET or HEAD on an exact asset path.
func accessAssetRequest(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	return r.URL.Path == accessAssetFilePath || r.URL.Path == accessAssetMarkdownPath
}

// accessCookieValue returns the single value of a cookie, and whether the
// request carried more than one, which fails closed.
func accessCookieValue(r *http.Request, name string) (value string, duplicates bool) {
	values := r.Cookies()
	found := false
	for _, cookie := range values {
		if cookie.Name != name {
			continue
		}
		if found {
			return "", true
		}
		found = true
		value = cookie.Value
	}
	return value, false
}

// accessCredentialFromRequest applies the transport rules: a bearer on an API
// path, a token query on a WebSocket path, never both, never the other
// transport, never a duplicate or empty value. Anything else is invalid rather
// than absent, so it fails closed instead of falling back to the cookie.
func accessCredentialFromRequest(r *http.Request) accessCredential {
	credential := accessCredential{}
	if value, duplicates := accessCookieValue(r, accessSessionCookie); duplicates {
		credential.Cookie = ""
	} else {
		credential.Cookie = value
	}
	if accessAssetRequest(r) {
		value, duplicates := accessCookieValue(r, accessAssetCookie)
		switch {
		case duplicates:
			credential.AssetState = accessCredentialInvalid
		case value != "":
			credential.Asset = value
			credential.AssetState = accessCredentialPresent
		}
	}
	authorization := r.Header.Values("Authorization")
	query, queryErr := url.ParseQuery(r.URL.RawQuery)
	tokenValues, hasQueryToken := query["token"]
	websocket := strings.HasPrefix(r.URL.Path, "/ws/")

	switch {
	case len(authorization) > 1 || len(tokenValues) > 1:
		credential.State = accessCredentialInvalid
	case len(authorization) == 1 && hasQueryToken:
		credential.State = accessCredentialInvalid
	case websocket && len(authorization) == 1:
		credential.State = accessCredentialInvalid
	case !websocket && hasQueryToken:
		credential.State = accessCredentialInvalid
	case queryErr != nil:
		// A malformed query can hide a token, so selection cannot prove that
		// the request has no explicit credential.
		credential.State = accessCredentialInvalid
	case len(authorization) == 1:
		token, ok := parseAccessBearer(authorization[0])
		if !ok {
			credential.State = accessCredentialInvalid
			return credential
		}
		credential.State = accessCredentialPresent
		credential.Token = token
	case hasQueryToken:
		token := tokenValues[0]
		if token == "" {
			credential.State = accessCredentialInvalid
			return credential
		}
		credential.State = accessCredentialPresent
		credential.Token = token
	}
	return credential
}

func parseAccessBearer(value string) (string, bool) {
	const prefix = "Bearer "
	if len(value) <= len(prefix) || !strings.EqualFold(value[:len(prefix)], prefix) {
		return "", false
	}
	token := value[len(prefix):]
	if strings.ContainsAny(token, " \t") {
		return "", false
	}
	return token, true
}

type accessLoginAttempt struct {
	Failures    int
	RetryAt     time.Time
	LastFailure time.Time
}

// accessRefreshBucket is the per-client refresh budget: a token bucket so a tab
// storm is bounded without touching the shared password-login backoff.
type accessRefreshBucket struct {
	tokens float64
	last   time.Time
}

type accessAuthManager struct {
	mu             sync.Mutex
	record         *accessPasswordRecord
	jwtKey         []byte
	v2             accessV2Runtime
	owner          accessStateLock
	owned          bool
	faulted        bool
	generation     uint64
	challenges     map[string]time.Time
	sessions       map[string]time.Time
	attempts       map[string]accessLoginAttempt
	refreshBuckets map[string]accessRefreshBucket
	now            func() time.Time
}

func newAccessAuthManager() *accessAuthManager {
	return &accessAuthManager{
		v2:             newAccessV2Runtime(),
		challenges:     make(map[string]time.Time),
		sessions:       make(map[string]time.Time),
		attempts:       make(map[string]accessLoginAttempt),
		refreshBuckets: make(map[string]accessRefreshBucket),
		now:            time.Now,
	}
}

var accessAuth = newAccessAuthManager()

// revokeAccessSockets fences client-facing sockets to generation. The auth
// layer owns the generation; the hub owns connection closure.
func revokeAccessSockets(generation uint64) {
	if wsHub != nil {
		wsHub.RotateAuth(generation)
	}
}

// configure activates the persisted record and reconciles session state. It is
// the startup entry point, so ownership is taken first: reconciliation writes
// the state file and a non-owner must never write it.
func (m *accessAuthManager) configure(encoded string) error {
	record, err := parseAccessPasswordHash(encoded)
	if err != nil {
		return err
	}
	key, err := accessJWTKey(record)
	if err != nil {
		return err
	}
	owned := m.owner.tryAcquire(accessV2LockPath())
	var state *accessV2StateFile
	var loadErr error
	if owned {
		state, loadErr = loadAccessV2StateFile(accessV2StatePath())
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.record = record
	m.jwtKey = key
	m.owned = owned
	m.generation++
	m.challenges = make(map[string]time.Time)
	m.sessions = make(map[string]time.Time)
	m.attempts = make(map[string]accessLoginAttempt)
	m.refreshBuckets = make(map[string]accessRefreshBucket)
	if !owned {
		// A second instance cannot tell whether the owner enabled or revoked
		// anything since it read Config, so it authorizes nothing at all.
		m.faulted = true
		m.v2 = newAccessV2Runtime()
		m.v2.recordBinding = accessRecordBinding(encoded)
		m.v2.epoch = 1
		return nil
	}
	return m.reconcileLocked(encoded, state, loadErr)
}

// stateOwned reports whether this process owns the auth state file, so the
// caller can log why authentication is unavailable instead of failing vaguely.
func (m *accessAuthManager) stateOwned() bool {
	if m.owner.held() {
		return true
	}
	return m.ownedNow()
}

// ownedNow reports the last known ownership without touching the lock file, so a
// protected request costs one mutex read rather than a filesystem call.
func (m *accessAuthManager) ownedNow() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.owned
}

// ensureOwned retries ownership for a process that started second. It returns
// true once this process may authorize anything, after reloading Config and
// reconciling the journal, so a recovered owner never admits from cache.
func (m *accessAuthManager) ensureOwned() bool {
	if m.stateOwned() {
		return true
	}
	cfg := loadConfig()
	if err := m.configure(cfg.AccessPasswordHash); err != nil {
		return false
	}
	return m.stateOwned()
}

// reconcileLocked installs state read from disk and resolves an interrupted
// password change: the journal decides whether Config or the state file won.
func (m *accessAuthManager) reconcileLocked(encoded string, state *accessV2StateFile, loadErr error) error {
	binding := accessRecordBinding(encoded)
	m.faulted = false
	if loadErr != nil {
		// Unreadable state is a fixed failure, not an excuse to start over:
		// guessing would resurrect sessions the owner revoked. v1 does not
		// depend on this file and keeps working.
		m.faulted = true
		m.v2 = newAccessV2Runtime()
		m.v2.recordBinding = binding
		m.v2.epoch = 1
		return nil
	}
	if state == nil {
		// First run: no record identity yet, so no older v2 token can be
		// accepted. The first raw-password login or enable writes the file.
		m.v2 = newAccessV2Runtime()
		m.v2.recordBinding = binding
		m.v2.epoch = 1
		return nil
	}
	active := state.Active
	pending := state.Pending
	switch {
	case pending != nil && accessRecordBinding(pending.PasswordRecord) == binding:
		// Config carries the journaled record: the commit happened, so the
		// journaled state is the truth.
		active = pending.Next
	case pending != nil && active.RecordBinding == binding:
		// Config still carries the previous record: the commit never landed.
		// Drop the journal and keep the old sessions.
	case pending != nil:
		// Neither binding matches: an out-of-band edit or an unsupported
		// history. Revoke everything rather than restore the journal's
		// password into Config.
		active = accessRevokedState(active, binding)
	case active.RecordBinding != binding:
		// Out-of-band record edit or a downgraded run: families minted under
		// another record must not survive.
		active = accessRevokedState(active, binding)
	}
	pruned := pruneExpiredAccessFamilies(&active, m.now())
	if err := m.loadRuntimeLocked(&active); err != nil {
		m.faulted = true
		m.v2 = newAccessV2Runtime()
		m.v2.recordBinding = binding
		m.v2.epoch = 1
		return nil
	}
	if pending != nil || pruned {
		// A journal entry or expired evidence must not survive the restart.
		if err := m.persistLocked(); err != nil {
			m.faulted = true
		}
	}
	return nil
}

// accessRevokedState keeps the record binding and drops every session, with a
// new epoch so a later identity cannot resurrect retained tokens.
func accessRevokedState(active accessV2ActiveState, binding string) accessV2ActiveState {
	next := accessV2ActiveState{
		RecordBinding: binding,
		Epoch:         active.Epoch + 1,
		Families:      []accessV2Family{},
	}
	if next.Epoch == 0 {
		// Epoch overflow: a fresh record identity restarts the counter instead
		// of wrapping it.
		next.Epoch = 1
	}
	return next
}

// pruneExpiredAccessFamilies drops families past either deadline and consumed
// evidence older than the retention window. It reports whether anything
// changed, so a caller can skip a pointless write.
func pruneExpiredAccessFamilies(active *accessV2ActiveState, now time.Time) bool {
	changed := false
	families := active.Families[:0]
	for i := range active.Families {
		family := active.Families[i]
		deadline := family.IdleExpiresAt
		if family.AbsoluteExpiresAt < deadline {
			deadline = family.AbsoluteExpiresAt
		}
		if now.Unix() >= deadline {
			changed = true
			continue
		}
		consumed := family.Consumed[:0]
		for _, entry := range family.Consumed {
			if now.Unix()-entry.ConsumedAt >= int64(accessConsumedRetention/time.Second) {
				changed = true
				continue
			}
			consumed = append(consumed, entry)
		}
		family.Consumed = consumed
		families = append(families, family)
	}
	active.Families = families
	return changed
}

// familyDeadline is the earlier of a family's two deadlines: past either one it
// can no longer authorize anything.
func familyDeadline(family *accessV2Family) time.Time {
	deadline := time.Unix(family.IdleExpiresAt, 0)
	if absolute := time.Unix(family.AbsoluteExpiresAt, 0); absolute.Before(deadline) {
		return absolute
	}
	return deadline
}

// commitActiveLocked persists next and only then installs it. Nothing is
// announced before the write succeeds, so a failed write leaves the live state,
// credentials, and sockets untouched.
func (m *accessAuthManager) commitActiveLocked(next *accessV2ActiveState) error {
	if !m.owned || m.faulted {
		return errAccessPersistence
	}
	pruneExpiredAccessFamilies(next, m.now())
	if err := saveAccessV2StateFile(accessV2StatePath(), &accessV2StateFile{
		Version: accessV2StateVersion,
		Active:  *next,
	}); err != nil {
		return err
	}
	return m.loadRuntimeLocked(next)
}

// signAccessToken mints one access token and returns the metadata needed to
// replay identical bytes from persisted state.
func signAccessToken(key []byte, now time.Time, revocation accessJWTRevocation) (string, accessV2Access, error) {
	nonce := make([]byte, accessJWTNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", accessV2Access{}, err
	}
	encodedNonce := base64.RawURLEncoding.EncodeToString(nonce)
	expiresAt := now.Add(accessJWTLifetime)
	token, err := formatAccessJWT(key, now.Unix(), expiresAt.Unix(), encodedNonce, revocation)
	if err != nil {
		return "", accessV2Access{}, err
	}
	return token, accessV2Access{IssuedAt: now.Unix(), ExpiresAt: expiresAt.Unix(), Nonce: encodedNonce}, nil
}

// --- family lifecycle ----------------------------------------------------

// evictAccessFamilyLocked removes a family from a candidate state by ID.
func evictAccessFamily(active *accessV2ActiveState, familyID string) bool {
	for i := range active.Families {
		if active.Families[i].ID != familyID {
			continue
		}
		active.Families = append(active.Families[:i], active.Families[i+1:]...)
		return true
	}
	return false
}

// findAccessFamily returns a mutable pointer to one family in a candidate
// state, so a rotation edits the copy that will be persisted.
func findAccessFamily(active *accessV2ActiveState, familyID string) *accessV2Family {
	for i := range active.Families {
		if active.Families[i].ID == familyID {
			return &active.Families[i]
		}
	}
	return nil
}

// enforceAccessFamilyCapacity evicts the least-recently-used family when a new
// login would exceed the family cap. This is capacity management, not a
// security event: the evicted client simply logs in again.
func enforceAccessFamilyCapacity(active *accessV2ActiveState) {
	for len(active.Families) >= maxAccessFamilies {
		victim := 0
		for i := 1; i < len(active.Families); i++ {
			current, candidate := active.Families[i], active.Families[victim]
			if current.LastUsedAt < candidate.LastUsedAt ||
				(current.LastUsedAt == candidate.LastUsedAt && current.ID < candidate.ID) {
				victim = i
			}
		}
		active.Families = append(active.Families[:victim], active.Families[victim+1:]...)
	}
}

// addAccessFamily prepares a complete family, its refresh handle, and its access
// token inside a candidate state. Nothing is persisted or announced here.
func addAccessFamily(active *accessV2ActiveState, key, refreshKey []byte, now time.Time) (*accessV2Family, accessV2Bundle, error) {
	if active.RecordID == "" || len(key) != accessJWTKeyBytes || len(refreshKey) != accessRefreshKeyBytes {
		return nil, accessV2Bundle{}, errors.New("access session state is not available")
	}
	familyID, err := randomAccessToken()
	if err != nil {
		return nil, accessV2Bundle{}, err
	}
	handle, err := accessRefreshHandle(refreshKey, familyID, 0)
	if err != nil {
		return nil, accessV2Bundle{}, err
	}
	digest, err := accessHandleDigest(handle)
	if err != nil {
		return nil, accessV2Bundle{}, err
	}
	token, access, err := signAccessToken(key, now, accessJWTRevocation{
		RecordID: active.RecordID,
		Epoch:    active.Epoch,
		FamilyID: familyID,
	})
	if err != nil {
		return nil, accessV2Bundle{}, err
	}
	idleExpiresAt := now.Add(accessRefreshIdle)
	if absoluteCap := now.Add(accessRefreshAbsolute); absoluteCap.Before(idleExpiresAt) {
		idleExpiresAt = absoluteCap
	}
	family := accessV2Family{
		ID:                familyID,
		Generation:        0,
		CreatedAt:         now.Unix(),
		LastUsedAt:        now.Unix(),
		IdleExpiresAt:     idleExpiresAt.Unix(),
		AbsoluteExpiresAt: now.Add(accessRefreshAbsolute).Unix(),
		ActiveDigest:      digest,
		CurrentAccess:     access,
		Consumed:          []accessV2Consumed{},
	}
	enforceAccessFamilyCapacity(active)
	active.Families = append(active.Families, family)
	return &family, accessV2Bundle{
		Token:                    token,
		ExpiresAt:                access.ExpiresAt,
		ExpiresIn:                int64(accessJWTLifetime / time.Second),
		RefreshHandle:            handle,
		RefreshIdleExpiresAt:     family.IdleExpiresAt,
		RefreshAbsoluteExpiresAt: family.AbsoluteExpiresAt,
	}, nil
}

// accessV2Bundle is one credential response. RefreshHandle travels only in the
// refresh cookie and never in JSON.
type accessV2Bundle struct {
	Token                    string
	ExpiresAt                int64
	ExpiresIn                int64
	RefreshHandle            string
	RefreshIdleExpiresAt     int64
	RefreshAbsoluteExpiresAt int64
}

// mintAccessJWTLocked mints a token for the current record in a new persisted
// family. The v2 routes build a full bundle instead; this is the narrow helper
// the v1 login path and tests use.
func (m *accessAuthManager) mintAccessJWTLocked(now time.Time) (string, error) {
	if m.record == nil || m.v2.recordID == "" || len(m.jwtKey) != accessJWTKeyBytes || len(m.v2.refreshKey) != accessRefreshKeyBytes {
		return "", nil
	}
	active := m.snapshotLocked()
	_, bundle, err := addAccessFamily(active, m.jwtKey, m.v2.refreshKey, now)
	if err != nil {
		return "", err
	}
	if err := m.commitActiveLocked(active); err != nil {
		return "", err
	}
	return bundle.Token, nil
}

// issueAccessFamilyLocked places a family in memory without persisting it.
// Production paths add families to a candidate state so the write comes first;
// this exists for tests that need a live family before minting a fixed token.
func (m *accessAuthManager) issueAccessFamilyLocked(now time.Time) (string, time.Time, error) {
	familyID, err := randomAccessToken()
	if err != nil {
		return "", time.Time{}, err
	}
	family := &accessV2Family{
		ID:                familyID,
		CreatedAt:         now.Unix(),
		LastUsedAt:        now.Unix(),
		IdleExpiresAt:     now.Add(accessRefreshIdle).Unix(),
		AbsoluteExpiresAt: now.Add(accessRefreshAbsolute).Unix(),
		Consumed:          []accessV2Consumed{},
	}
	m.v2.families[familyID] = family
	return familyID, time.Unix(family.IdleExpiresAt, 0), nil
}

// accessGeneration fences WebSocket upgrades against record changes.
func (m *accessAuthManager) accessGeneration() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.generation
}

func (m *accessAuthManager) enabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.record != nil
}

// statusAndChallenge returns public KDF parameters and a single-use login
// challenge from one locked snapshot, so a concurrent password change cannot
// pair an old salt with a challenge for the new verifier.
func (m *accessAuthManager) statusAndChallenge() (enabled bool, salt, challenge string, iterations int, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.record == nil {
		return false, "", "", 0, nil
	}
	now := time.Now()
	m.cleanExpiredLocked(now)
	if len(m.challenges) >= maxAccessChallenges {
		return false, "", "", 0, errors.New("too many pending login attempts")
	}
	challenge, err = randomAccessToken()
	if err != nil {
		return false, "", "", 0, err
	}
	m.challenges[challenge] = now.Add(accessChallengeTTL)
	return true, base64.RawURLEncoding.EncodeToString(m.record.Salt), challenge, m.record.Iterations, nil
}

func (m *accessAuthManager) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(accessSessionCookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cookieValidLocked(cookie.Value, time.Now())
}

// cookieValidLocked verifies a v1 session token against the current verifier.
// Callers hold the mutex.
func (m *accessAuthManager) cookieValidLocked(token string, now time.Time) bool {
	if m.record == nil || token == "" {
		return false
	}
	expiresAt, ok := m.sessions[token]
	if ok {
		if expiresAt.After(now) {
			return true
		}
		delete(m.sessions, token)
		return false
	}
	// Stateless token verification across server restarts. The token is
	// signed with the current verifier, so it remains valid across restarts
	// until expiry whilst any password change automatically invalidates it.
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	expiresUnix, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return false
	}
	tokenExpiry := time.Unix(expiresUnix, 0)
	if !tokenExpiry.After(now) {
		return false
	}
	gotSig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(gotSig) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, m.record.Verifier)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	wantSig := mac.Sum(nil)
	if subtle.ConstantTimeCompare(gotSig, wantSig) != 1 {
		return false
	}
	m.sessions[token] = tokenExpiry
	return true
}

// jwtValidLocked verifies an explicit v2 token against the current key, then
// against the current record identity, epoch, and live family. expiryAllowance
// widens only the expiry comparison: browsers tolerate clock drift, sockets
// close at exp. Callers hold the mutex.
func (m *accessAuthManager) jwtValidLocked(token string, now time.Time, expiryAllowance time.Duration) bool {
	_, ok := m.jwtClaimsLocked(token, now, expiryAllowance)
	return ok
}

// jwtClaimsLocked is jwtValidLocked plus the verified claims, so logout can act
// on the family the bearer names. Callers hold the mutex.
func (m *accessAuthManager) jwtClaimsLocked(token string, now time.Time, expiryAllowance time.Duration) (*accessJWTClaims, bool) {
	if m.faulted || len(m.jwtKey) != accessJWTKeyBytes || token == "" || m.record == nil || m.v2.recordID == "" {
		return nil, false
	}
	claims, err := parseAccessJWT(m.jwtKey, token, now, expiryAllowance)
	if err != nil {
		return nil, false
	}
	if claims.RecordID != m.v2.recordID || claims.Epoch != m.v2.epoch {
		return nil, false
	}
	family, ok := m.v2.families[claims.FamilyID]
	if !ok || !familyDeadline(family).Add(expiryAllowance).After(now) {
		return nil, false
	}
	return claims, true
}

// accessDecision is the result of one authorization check. Generation is read
// under the same lock, so a WebSocket upgrade can prove it attached at a
// generation that was still current when the decision was made.
type accessDecision struct {
	Authorized bool
	Generation uint64
}

// authorizeRequest applies the explicit-credential priority table. An explicit
// v2 credential decides the result on its own and never falls back to a cookie.
func (m *accessAuthManager) authorizeRequest(r *http.Request) accessDecision {
	m.mu.Lock()
	defer m.mu.Unlock()
	decision := accessDecision{Generation: m.generation}
	if !m.owned {
		// A non-owner cannot tell "disabled" from "enabled since my last read",
		// so it admits nothing rather than trust its own stale view.
		return decision
	}
	if m.record == nil {
		decision.Authorized = true
		return decision
	}
	credential := accessCredentialFromRequest(r)
	if credential.State == accessCredentialInvalid || credential.AssetState == accessCredentialInvalid {
		return decision
	}
	now := m.now()
	if credential.State == accessCredentialPresent {
		decision.Authorized = m.jwtValidLocked(credential.Token, now, accessExpiryAllowance(r.URL.Path))
		return decision
	}
	// The asset cookie decides alone on the two reads it is scoped to: an
	// invalid one is a 401, never a fallback to the v1 cookie.
	if credential.AssetState == accessCredentialPresent {
		decision.Authorized = m.jwtValidLocked(credential.Asset, now, accessJWTClockAllowance)
		return decision
	}
	decision.Authorized = m.cookieValidLocked(credential.Cookie, now)
	return decision
}

// accessExpiryAllowance is the expiry tolerance for one protected path. A
// socket must close at exp itself, so only browser requests get the allowance
// the contract grants them.
func accessExpiryAllowance(path string) time.Duration {
	if strings.HasPrefix(path, "/ws/") {
		return 0
	}
	return accessJWTClockAllowance
}

func (m *accessAuthManager) login(challenge, proof, remoteAddr string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.cleanExpiredLocked(now)
	if m.record == nil {
		return "", nil
	}

	client := accessClientIP(remoteAddr)
	if attempt, ok := m.attempts[client]; ok && attempt.RetryAt.After(now) {
		return "", errAccessRateLimited
	}

	expiresAt, ok := m.challenges[challenge]
	delete(m.challenges, challenge) // one-time, including bad attempts
	if !ok || !expiresAt.After(now) {
		m.recordFailureLocked(client, now)
		return "", errAccessUnauthorized
	}
	got, err := base64.RawURLEncoding.DecodeString(proof)
	if err != nil || len(got) != sha256.Size {
		m.recordFailureLocked(client, now)
		return "", errAccessUnauthorized
	}
	mac := hmac.New(sha256.New, m.record.Verifier)
	_, _ = mac.Write([]byte(challenge))
	want := mac.Sum(nil)
	if subtle.ConstantTimeCompare(got, want) != 1 {
		m.recordFailureLocked(client, now)
		return "", errAccessUnauthorized
	}

	delete(m.attempts, client)
	return m.newSessionLocked(now)
}

// setEncodedPassword applies a v1 password change. The request credential is
// re-evaluated under the lock, so a record change between middleware evaluation
// and this call still rejects an unauthorized caller. The v1 route never
// returns v2 credentials, so no family is issued for it.
func (m *accessAuthManager) setEncodedPassword(encoded string, credential accessCredential) (accessPasswordOutcome, error) {
	record, err := parseAccessPasswordHash(encoded)
	if err != nil {
		return accessPasswordOutcome{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	if !m.authorizedForPasswordLocked(credential, now) {
		return accessPasswordOutcome{}, errAccessUnauthorized
	}
	return m.commitPasswordLocked(record, now, false)
}

// setRawPassword applies a v2 set or change. Clearing uses clearPassword.
func (m *accessAuthManager) setRawPassword(password string, credential accessCredential) (accessPasswordOutcome, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()

	// Authorize before deriving: an unauthenticated caller must not turn this
	// public route into an unrestricted PBKDF2 cost. The lock is held through
	// derivation so a concurrent record change cannot race the new record.
	if !m.authorizedForPasswordLocked(credential, now) {
		return accessPasswordOutcome{}, errAccessUnauthorized
	}
	record, err := newAccessPasswordRecord(password)
	if err != nil {
		return accessPasswordOutcome{}, err
	}
	return m.commitPasswordLocked(record, now, true)
}

// clearPassword disables authentication. Callers pass only the explicit v2
// bearer, so a cookie alone cannot disable a v2 password.
func (m *accessAuthManager) clearPassword(credential accessCredential) (accessPasswordOutcome, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	if m.record == nil {
		return accessPasswordOutcome{}, errAccessNotEnabled
	}
	if !m.authorizedForPasswordLocked(credential, now) {
		return accessPasswordOutcome{}, errAccessUnauthorized
	}
	return m.commitPasswordLocked(nil, now, false)
}

// loginPassword verifies a raw password and returns a fresh credential bundle.
// A stale work factor is rehashed: the replacement is persisted before
// activation, so a failed write leaves the old record and key valid.
func (m *accessAuthManager) loginPassword(password, remoteAddr string) (accessV2Bundle, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	m.cleanExpiredLocked(now)
	if m.record == nil {
		return accessV2Bundle{}, errAccessUnauthorized
	}

	client := accessClientIP(remoteAddr)
	if attempt, ok := m.attempts[client]; ok && attempt.RetryAt.After(now) {
		return accessV2Bundle{}, errAccessRateLimited
	}
	matched, err := m.record.matchesPassword(password)
	if err != nil {
		return accessV2Bundle{}, err
	}
	if !matched {
		m.recordFailureLocked(client, now)
		return accessV2Bundle{}, errAccessUnauthorized
	}

	replacement, changed, err := m.record.rehashed(password)
	if err != nil {
		return accessV2Bundle{}, err
	}
	if changed {
		outcome, err := m.commitPasswordLocked(replacement, now, true)
		if err != nil {
			return accessV2Bundle{}, err
		}
		if outcome.Bundle == nil {
			return accessV2Bundle{}, errAccessPersistence
		}
		delete(m.attempts, client)
		return *outcome.Bundle, nil
	}

	// A current-parameter login opens a new family and keeps the existing ones:
	// signing in from another device must not sign the first device out.
	active := m.snapshotLocked()
	_, bundle, err := addAccessFamily(active, m.jwtKey, m.v2.refreshKey, now)
	if err != nil {
		return accessV2Bundle{}, err
	}
	if err := m.commitActiveLocked(active); err != nil {
		return accessV2Bundle{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
	}
	delete(m.attempts, client)
	return bundle, nil
}

// accessPasswordOutcome reports the credentials minted by one guarded record
// change. Both are empty when the change cleared the password.
type accessPasswordOutcome struct {
	CookieToken string
	Bundle      *accessV2Bundle
}

// authorizedForPasswordLocked re-checks the caller against the current record.
// A disabled record accepts anyone: that is the initial enable.
func (m *accessAuthManager) authorizedForPasswordLocked(credential accessCredential, now time.Time) bool {
	if m.record == nil {
		return true
	}
	switch credential.State {
	case accessCredentialInvalid:
		return false
	case accessCredentialPresent:
		return m.jwtValidLocked(credential.Token, now, accessJWTClockAllowance)
	}
	return m.cookieValidLocked(credential.Cookie, now)
}

// accessRecordPlan is one prepared password change: the new record, its derived
// keys, and the complete session state that becomes active with it. Every
// fallible step runs before the first durable write.
type accessRecordPlan struct {
	record  *accessPasswordRecord
	encoded string
	key     []byte
	next    accessV2ActiveState
	bundle  accessV2Bundle
	cookie  string
}

// prepareRecordPlanLocked builds the replacement record identity, its refresh
// key, and (when asked) its first family, before anything is written.
func (m *accessAuthManager) prepareRecordPlanLocked(record *accessPasswordRecord, now time.Time, withFamily bool) (*accessRecordPlan, error) {
	plan := &accessRecordPlan{record: record}
	if record != nil {
		plan.encoded = record.encoded()
	}
	plan.next = accessV2ActiveState{
		RecordBinding: accessRecordBinding(plan.encoded),
		Epoch:         1,
		Families:      []accessV2Family{},
	}
	if record == nil {
		return plan, nil
	}
	key, err := accessJWTKey(record)
	if err != nil {
		return nil, err
	}
	plan.key = key
	recordID, err := randomAccessToken()
	if err != nil {
		return nil, err
	}
	refreshKey, err := accessRefreshKey(record)
	if err != nil {
		return nil, err
	}
	encodedKey := base64.RawURLEncoding.EncodeToString(refreshKey)
	plan.next.RecordID = recordID
	plan.next.RefreshKey = &encodedKey
	if plan.cookie, err = signAccessSession(record.Verifier, now); err != nil {
		return nil, err
	}
	if !withFamily {
		return plan, nil
	}
	_, bundle, err := addAccessFamily(&plan.next, key, refreshKey, now)
	if err != nil {
		return nil, err
	}
	plan.bundle = bundle
	return plan, nil
}

// commitPasswordLocked persists the replacement before activating it, so a
// failed write leaves the old record, key, credentials, and sockets valid.
//
// A changed record touches two files (Config and the state file) and one
// rename cannot cover both, so the journal makes a crash at any single
// instruction recoverable: prepare, commit Config, promote. The same encoded
// record needs only one state replacement, because the deterministic v1
// signature cannot be rotated anyway.
func (m *accessAuthManager) commitPasswordLocked(record *accessPasswordRecord, now time.Time, withFamily bool) (accessPasswordOutcome, error) {
	if !m.owned {
		// A non-owner must never write the state file, and a password change is
		// a state write.
		return accessPasswordOutcome{}, fmt.Errorf("%w: %v", errAccessPersistence, errAccessForbidden)
	}
	plan, err := m.prepareRecordPlanLocked(record, now, withFamily)
	if err != nil {
		return accessPasswordOutcome{}, err
	}
	current := m.snapshotLocked()
	journaled := current.RecordBinding != plan.next.RecordBinding

	if journaled {
		journal := &accessV2StateFile{
			Version: accessV2StateVersion,
			Active:  *current,
			Pending: &accessV2Pending{
				FromRecordBinding: current.RecordBinding,
				PasswordRecord:    plan.encoded,
				Next:              plan.next,
			},
		}
		if err := saveAccessV2StateFile(accessV2StatePath(), journal); err != nil {
			// Known pre-commit failure: Config still carries the old record, so
			// the old credentials and sockets stay valid.
			return accessPasswordOutcome{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
		}
		if err := saveAccessPasswordHash(plan.encoded); err != nil {
			// The commit point did not happen. The pending entry is cleaned up
			// by reconciliation on the next start.
			return accessPasswordOutcome{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
		}
		// Config now carries the new record. v1 must follow it even if the
		// promotion fails, or v1 would authorize against an older durable
		// record than the one on disk.
		m.record = plan.record
		m.jwtKey = plan.key
		m.sessions = make(map[string]time.Time)
		m.challenges = make(map[string]time.Time)
		if err := saveAccessV2StateFile(accessV2StatePath(), &accessV2StateFile{
			Version: accessV2StateVersion,
			Active:  plan.next,
		}); err != nil {
			// Ambiguous: the record is committed but the journal is not
			// promoted. Fault v2 closed until reconciliation instead of
			// claiming success or promising a rollback.
			m.faulted = true
			m.v2 = newAccessV2Runtime()
			m.v2.recordBinding = plan.next.RecordBinding
			m.v2.epoch = plan.next.Epoch
			m.generation++
			revokeAccessSockets(m.generation)
			return accessPasswordOutcome{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
		}
	} else if err := saveAccessV2StateFile(accessV2StatePath(), &accessV2StateFile{
		Version: accessV2StateVersion,
		Active:  plan.next,
	}); err != nil {
		return accessPasswordOutcome{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
	}

	if err := m.loadRuntimeLocked(&plan.next); err != nil {
		// The durable state was written; keep it authoritative and refuse v2
		// until reconciliation rather than serve from a half-built runtime.
		m.faulted = true
		return accessPasswordOutcome{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
	}
	m.faulted = false
	m.record = plan.record
	m.jwtKey = plan.key
	m.generation++
	m.challenges = make(map[string]time.Time)
	m.sessions = make(map[string]time.Time)
	m.attempts = make(map[string]accessLoginAttempt)
	if plan.cookie != "" {
		m.sessions[plan.cookie] = now.Add(accessSessionTTL)
	}
	// Fence client-facing sockets to the new generation while the record
	// change is still under the lock. A socket admitted at the old
	// generation cannot outlive the credential that authorized it.
	revokeAccessSockets(m.generation)
	outcome := accessPasswordOutcome{CookieToken: plan.cookie}
	if plan.bundle.Token != "" {
		bundle := plan.bundle
		outcome.Bundle = &bundle
	}
	return outcome, nil
}

// refresh rotates one refresh handle under the manager lock. Everything is
// prepared, persisted, and only then activated, so no response can escape
// before the state that backs it is durable. The lock is taken here rather than
// by the caller because rotation reads and writes every shared index, and two
// concurrent retries of one handle must serialize into a rotation plus a grace
// replay instead of racing.
func (m *accessAuthManager) refresh(handle, client string, now time.Time) (accessV2Bundle, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.record == nil {
		return accessV2Bundle{}, errAccessUnauthorized
	}
	if m.faulted {
		return accessV2Bundle{}, errAccessPersistence
	}
	if !m.takeRefreshToken(client, now) {
		return accessV2Bundle{}, errAccessRefreshLimit
	}
	digest, err := accessHandleDigest(handle)
	if err != nil {
		return accessV2Bundle{}, errAccessUnauthorized
	}
	if familyID, ok := m.v2.active[digest]; ok {
		return m.rotateRefreshLocked(familyID, digest, now)
	}
	if consumed, ok := m.v2.consumed[digest]; ok {
		return m.replayRefreshLocked(consumed, now)
	}
	return accessV2Bundle{}, errAccessUnauthorized
}

// rotateRefreshLocked consumes the presented handle, derives the next one, and
// mints a new access token. The old digest stays as replay evidence.
func (m *accessAuthManager) rotateRefreshLocked(familyID, digest string, now time.Time) (accessV2Bundle, error) {
	current := m.v2.families[familyID]
	if current == nil {
		return accessV2Bundle{}, errAccessUnauthorized
	}
	if !familyDeadline(current).After(now) {
		// Expired is terminal for this family, exactly like an unknown handle.
		return accessV2Bundle{}, errAccessUnauthorized
	}
	active := m.snapshotLocked()
	family := findAccessFamily(active, familyID)
	if family == nil {
		return accessV2Bundle{}, errAccessUnauthorized
	}
	if len(family.Consumed) >= maxAccessConsumedPerFam {
		// Never evict younger replay evidence to make room: the family is
		// revoked durably instead.
		return m.revokeFamilyLocked(familyID, now)
	}
	generation := family.Generation + 1
	if generation == 0 {
		return m.revokeFamilyLocked(familyID, now)
	}
	handle, err := accessRefreshHandle(m.v2.refreshKey, familyID, generation)
	if err != nil {
		return accessV2Bundle{}, err
	}
	newDigest, err := accessHandleDigest(handle)
	if err != nil {
		return accessV2Bundle{}, err
	}
	token, access, err := signAccessToken(m.jwtKey, now, accessJWTRevocation{
		RecordID: active.RecordID,
		Epoch:    active.Epoch,
		FamilyID: familyID,
	})
	if err != nil {
		return accessV2Bundle{}, err
	}
	idleExpiresAt := now.Add(accessRefreshIdle)
	if absoluteCap := time.Unix(family.AbsoluteExpiresAt, 0); absoluteCap.Before(idleExpiresAt) {
		idleExpiresAt = absoluteCap
	}
	family.Consumed = append(family.Consumed, accessV2Consumed{Digest: digest, ConsumedAt: now.Unix()})
	family.Generation = generation
	family.ActiveDigest = newDigest
	family.LastUsedAt = now.Unix()
	family.IdleExpiresAt = idleExpiresAt.Unix()
	family.CurrentAccess = access
	if err := m.commitActiveLocked(active); err != nil {
		return accessV2Bundle{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
	}
	return accessV2Bundle{
		Token:                    token,
		ExpiresAt:                access.ExpiresAt,
		ExpiresIn:                int64(accessJWTLifetime / time.Second),
		RefreshHandle:            handle,
		RefreshIdleExpiresAt:     family.IdleExpiresAt,
		RefreshAbsoluteExpiresAt: family.AbsoluteExpiresAt,
	}, nil
}

// replayRefreshLocked answers a retry inside the grace window with the current
// family credentials, unchanged and unextended. Outside the window the handle
// is a reuse signal: the family is revoked durably and the caller starts over.
func (m *accessAuthManager) replayRefreshLocked(consumed accessV2ConsumedRef, now time.Time) (accessV2Bundle, error) {
	family := m.v2.families[consumed.FamilyID]
	if family == nil || !familyDeadline(family).After(now) {
		return accessV2Bundle{}, errAccessUnauthorized
	}
	age := now.Sub(consumed.ConsumedAt)
	if age < 0 || age > accessRefreshGrace {
		return m.revokeFamilyLocked(consumed.FamilyID, now)
	}
	handle, err := accessRefreshHandle(m.v2.refreshKey, family.ID, family.Generation)
	if err != nil {
		return accessV2Bundle{}, err
	}
	// Rebuild the exact bytes the family already served: same claims, same
	// nonce, same deadlines. Grace must be idempotent, not a second renewal.
	token, err := formatAccessJWT(m.jwtKey, family.CurrentAccess.IssuedAt, family.CurrentAccess.ExpiresAt, family.CurrentAccess.Nonce, accessJWTRevocation{
		RecordID: m.v2.recordID,
		Epoch:    m.v2.epoch,
		FamilyID: family.ID,
	})
	if err != nil {
		return accessV2Bundle{}, err
	}
	return accessV2Bundle{
		Token:                    token,
		ExpiresAt:                family.CurrentAccess.ExpiresAt,
		ExpiresIn:                family.CurrentAccess.ExpiresAt - now.Unix(),
		RefreshHandle:            handle,
		RefreshIdleExpiresAt:     family.IdleExpiresAt,
		RefreshAbsoluteExpiresAt: family.AbsoluteExpiresAt,
	}, nil
}

// revokeFamilyLocked durably retires one family, closes its sockets, and
// reports the fixed 401 so the caller learns nothing about why.
func (m *accessAuthManager) revokeFamilyLocked(familyID string, now time.Time) (accessV2Bundle, error) {
	active := m.snapshotLocked()
	if !evictAccessFamily(active, familyID) {
		return accessV2Bundle{}, errAccessUnauthorized
	}
	if err := m.commitActiveLocked(active); err != nil {
		return accessV2Bundle{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
	}
	revokeAccessSockets(m.generation)
	return accessV2Bundle{}, errAccessUnauthorized
}

// logoutLocked revokes the bearer's family, or every family with its epoch, then
// fences sockets. Neither clears v1 cookies: their signature is unaffected and
// v1 has no epoch to advance.
func (m *accessAuthManager) logoutLocked(claims *accessJWTClaims, all bool, now time.Time) error {
	if m.faulted {
		return errAccessPersistence
	}
	active := m.snapshotLocked()
	if all {
		active.Families = []accessV2Family{}
		active.Epoch++
		if active.Epoch == 0 {
			recordID, err := randomAccessToken()
			if err != nil {
				return err
			}
			active.RecordID = recordID
			active.Epoch = 1
		}
	} else if !evictAccessFamily(active, claims.FamilyID) {
		return errAccessUnauthorized
	}
	if err := m.commitActiveLocked(active); err != nil {
		return fmt.Errorf("%w: %v", errAccessPersistence, err)
	}
	m.generation++
	revokeAccessSockets(m.generation)
	return nil
}

// takeRefreshToken applies the per-client refresh budget. A refresh storm must
// not touch, clear, or lock out the shared password-login backoff.
func (m *accessAuthManager) takeRefreshToken(client string, now time.Time) bool {
	bucket, ok := m.refreshBuckets[client]
	if !ok {
		if len(m.refreshBuckets) >= maxAccessRefreshBuckets {
			m.reclaimRefreshBuckets(now)
			if len(m.refreshBuckets) >= maxAccessRefreshBuckets {
				return false
			}
		}
		bucket = accessRefreshBucket{tokens: accessRefreshBurst, last: now}
	}
	elapsed := now.Sub(bucket.last).Seconds()
	if elapsed > 0 {
		bucket.tokens += elapsed * (accessRefreshPerMinute / 60.0)
		if bucket.tokens > accessRefreshBurst {
			bucket.tokens = accessRefreshBurst
		}
	}
	bucket.last = now
	if bucket.tokens < 1 {
		m.refreshBuckets[client] = bucket
		return false
	}
	bucket.tokens--
	m.refreshBuckets[client] = bucket
	return true
}

func (m *accessAuthManager) reclaimRefreshBuckets(now time.Time) {
	for client, bucket := range m.refreshBuckets {
		if !bucket.last.Add(accessRefreshBucketIdle).After(now) {
			delete(m.refreshBuckets, client)
		}
	}
}

func (m *accessAuthManager) newSessionLocked(now time.Time) (string, error) {
	m.cleanExpiredLocked(now)
	if m.record == nil {
		return "", nil
	}
	token, err := signAccessSession(m.record.Verifier, now)
	if err != nil {
		return "", err
	}
	m.sessions[token] = now.Add(accessSessionTTL)
	return token, nil
}

// signAccessSession mints a v1 cookie token without storing it, so a record
// change can persist first and activate the session only after the write.
func signAccessSession(verifier []byte, now time.Time) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	nonce := base64.RawURLEncoding.EncodeToString(buf)
	expiresAt := now.Add(accessSessionTTL)
	expiresStr := strconv.FormatInt(expiresAt.Unix(), 10)
	payload := nonce + "." + expiresStr
	mac := hmac.New(sha256.New, verifier)
	_, _ = mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (m *accessAuthManager) recordFailureLocked(client string, now time.Time) {
	attempt := m.attempts[client]
	attempt.Failures++
	// 1, 2, 4, ... seconds, capped at a minute. This is deliberately
	// in-memory: restart resets it, matching Phi's no-account design.
	delay := time.Second << min(attempt.Failures-1, 6)
	attempt.RetryAt = now.Add(delay)
	attempt.LastFailure = now
	m.attempts[client] = attempt
}

func (m *accessAuthManager) cleanExpiredLocked(now time.Time) {
	for challenge, expiresAt := range m.challenges {
		if !expiresAt.After(now) {
			delete(m.challenges, challenge)
		}
	}
	for session, expiresAt := range m.sessions {
		if !expiresAt.After(now) {
			delete(m.sessions, session)
		}
	}
	for client, attempt := range m.attempts {
		if !attempt.LastFailure.Add(15 * time.Minute).After(now) {
			delete(m.attempts, client)
		}
	}
}

func randomAccessToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func accessClientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}
	return remoteAddr
}

func accessAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if accessAuthPublicPath(r.URL.Path) || isSyncBoardPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if !accessAuth.ownedNow() {
			// A second instance serves the UI but authorizes nothing: it cannot
			// tell whether the owner enabled or revoked since it read Config.
			http.Error(w, "access authentication required", http.StatusUnauthorized)
			return
		}
		decision := accessAuth.authorizeRequest(r)
		if !decision.Authorized {
			http.Error(w, "access authentication required", http.StatusUnauthorized)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/ws/") {
			// Carry the generation from the same lock acquisition as the
			// decision, so the upgrade can reject a socket that a password
			// change retired in between.
			r = r.WithContext(ws.WithAuthFence(r.Context(), ws.AuthFence{Generation: decision.Generation}))
		}
		next.ServeHTTP(w, r)
	})
}

// isSyncBoardPath marks the sync board as reachable without a browser session.
//
// This phi instance *is* the coordinator -- other machines POST to it -- so
// those callers have no session cookie and started failing with "access
// authentication required" once an access password was set.
//
// The board carries coordination metadata between the operator's own machines,
// and anyone who can reach this port can already reach the web UI, the
// terminals and the file tree. A separate credential here would not protect
// anything that is not already exposed; it would only break syncing.
//
// The exemption is kept narrow on purpose. It covers the message endpoints and
// nothing else -- notably not /api/config/sync-coordinator, which changes where
// this instance syncs to.
func isSyncBoardPath(path string) bool {
	return path == "/api/sync/messages" || strings.HasPrefix(path, "/api/sync/messages/")
}

// accessAuthPublicPath lists the exact exemptions: v1 status/login and the five
// v2 auth routes, which authorize themselves. Anything else under /api or /ws
// passes through accessAuthMiddleware.
func accessAuthPublicPath(path string) bool {
	switch path {
	case "/api/auth/status", "/api/auth/login",
		"/api/auth/v2/status", "/api/auth/v2/login", "/api/auth/v2/password",
		"/api/auth/v2/refresh", "/api/auth/v2/logout",
		"/livez", "/healthz", "/readyz":
		return true
	}
	return !strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/ws/")
}

func handleAccessAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	enabled, salt, challenge, iterations, err := accessAuth.statusAndChallenge()
	if err != nil {
		http.Error(w, "Unable to start login: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	payload := map[string]interface{}{
		"enabled":       enabled,
		"authenticated": enabled && accessAuth.authenticated(r),
		"protocols":     []string{accessPasswordHashVersion, accessJWTProtocol},
	}
	if enabled {
		payload["version"] = accessPasswordHashVersion
		payload["algorithm"] = accessPasswordHashAlgorithm
		payload["iterations"] = iterations
		payload["salt"] = salt
		payload["challenge"] = challenge
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func handleAccessAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Challenge string `json:"challenge"`
		Proof     string `json:"proof"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "Invalid login request", http.StatusBadRequest)
		return
	}
	if !accessAuth.ensureOwned() {
		http.Error(w, "Unable to login", http.StatusInternalServerError)
		return
	}
	token, err := accessAuth.login(req.Challenge, req.Proof, r.RemoteAddr)
	if err != nil {
		if errors.Is(err, errAccessRateLimited) {
			http.Error(w, err.Error(), http.StatusTooManyRequests)
			return
		}
		if errors.Is(err, errAccessUnauthorized) {
			http.Error(w, "Invalid password", http.StatusUnauthorized)
			return
		}
		http.Error(w, "Unable to login", http.StatusInternalServerError)
		return
	}
	if token != "" {
		setAccessSessionCookie(w, r, token)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func handleAccessPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PasswordHash string `json:"password_hash"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		return
	}
	if len(req.PasswordHash) > 512 {
		http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		return
	}
	if !accessAuth.ensureOwned() {
		http.Error(w, "Unable to save access password", http.StatusInternalServerError)
		return
	}
	outcome, err := accessAuth.setEncodedPassword(req.PasswordHash, accessCredentialFromRequest(r))
	if err != nil {
		switch {
		case errors.Is(err, errAccessUnauthorized):
			http.Error(w, "access authentication required", http.StatusUnauthorized)
		case errors.Is(err, errAccessPersistence):
			http.Error(w, "Unable to save access password", http.StatusInternalServerError)
		default:
			http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		}
		return
	}

	if outcome.CookieToken == "" {
		clearAccessSessionCookie(w, r)
	} else {
		setAccessSessionCookie(w, r, outcome.CookieToken)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": outcome.CookieToken != ""})
}

// handleAccessV2Status reports enforcement, whether the request carries a valid
// explicit bearer, and whether this process owns the auth state. A cookie never
// authenticates this endpoint.
func handleAccessV2Status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		accessMethodNotAllowed(w, http.MethodGet)
		return
	}
	enabled, authenticated, owned := accessAuth.v2Status(r)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]bool{
		"enabled":       enabled,
		"authenticated": authenticated,
		"owned":         owned,
	})
}

func (m *accessAuthManager) v2Status(r *http.Request) (enabled, authenticated, owned bool) {
	// A second instance recovers ownership here once the first exits, instead
	// of requiring a restart.
	m.ensureOwned()
	credential := accessCredentialFromRequest(r)
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	enabled = m.record != nil
	owned = m.owned
	if !owned || !enabled || credential.State != accessCredentialPresent {
		return enabled, false, owned
	}
	return enabled, m.jwtValidLocked(credential.Token, now, accessJWTClockAllowance), owned
}

func handleAccessV2Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		accessMethodNotAllowed(w, http.MethodPost)
		return
	}
	secure, ok := accessV2Allowed(w, r)
	if !ok {
		return
	}
	if !accessJSONContentType(r) {
		accessError(w, "Invalid login request", http.StatusBadRequest)
		return
	}
	password, ok := decodeAccessPasswordBody(w, r)
	if !ok || len(password) < accessPasswordMinBytes || len(password) > accessPasswordMaxBytes {
		accessError(w, "Invalid login request", http.StatusBadRequest)
		return
	}
	if !accessAuth.ensureOwned() {
		accessError(w, "Unable to login", http.StatusInternalServerError)
		return
	}
	bundle, err := accessAuth.loginPassword(password, r.RemoteAddr)
	if err != nil {
		switch {
		case errors.Is(err, errAccessRateLimited):
			accessError(w, err.Error(), http.StatusTooManyRequests)
		case errors.Is(err, errAccessUnauthorized):
			accessError(w, "Invalid password", http.StatusUnauthorized)
		default:
			accessError(w, "Unable to login", http.StatusInternalServerError)
		}
		return
	}
	setAccessV2Cookies(w, r, bundle, secure)
	writeAccessV2Bundle(w, bundle)
}

func handleAccessV2Password(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		accessMethodNotAllowed(w, http.MethodPost)
		return
	}
	secure, ok := accessV2Allowed(w, r)
	if !ok {
		return
	}
	if !accessJSONContentType(r) {
		accessError(w, "Invalid password configuration", http.StatusBadRequest)
		return
	}
	password, ok := decodeAccessPasswordBody(w, r)
	if !ok {
		accessError(w, "Invalid password configuration", http.StatusBadRequest)
		return
	}
	if !accessAuth.ensureOwned() {
		accessError(w, "Unable to save access password", http.StatusInternalServerError)
		return
	}
	// This route accepts an explicit bearer only: a cookie cannot set or clear
	// a v2 password, so it is dropped before the credential check.
	credential := accessCredentialFromRequest(r)
	credential.Cookie = ""
	credential.Asset = ""
	credential.AssetState = accessCredentialNone

	var outcome accessPasswordOutcome
	var err error
	if password == "" {
		outcome, err = accessAuth.clearPassword(credential)
	} else if len(password) < accessPasswordMinBytes || len(password) > accessPasswordMaxBytes {
		accessError(w, "Invalid password configuration", http.StatusBadRequest)
		return
	} else {
		outcome, err = accessAuth.setRawPassword(password, credential)
	}
	if err != nil {
		switch {
		case errors.Is(err, errAccessNotEnabled):
			accessError(w, "Access password is not enabled", http.StatusBadRequest)
		case errors.Is(err, errAccessUnauthorized):
			accessError(w, "access authentication required", http.StatusUnauthorized)
		default:
			accessError(w, "Unable to save access password", http.StatusInternalServerError)
		}
		return
	}

	if password == "" {
		clearAccessV2Cookies(w, secure)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": false})
		return
	}
	bundle := accessV2Bundle{}
	if outcome.Bundle != nil {
		bundle = *outcome.Bundle
	}
	setAccessV2Cookies(w, r, bundle, secure)
	writeEnabledAccessV2Bundle(w, bundle)
}

func handleAccessV2Refresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		accessMethodNotAllowed(w, http.MethodPost)
		return
	}
	secure, ok := accessV2Allowed(w, r)
	if !ok {
		return
	}
	// The refresh route is the one carrier of the refresh cookie: an explicit
	// credential or a token query here is a carrier mix-up, not a fallback.
	// Body validation runs first, so an invalid body is reported as one.
	if !accessJSONContentType(r) || !accessDecodeEmptyBody(w, r) {
		accessError(w, "Invalid refresh request", http.StatusBadRequest)
		return
	}
	if len(r.Header.Values("Authorization")) != 0 {
		accessError(w, errAccessUnauthorized.Error(), http.StatusUnauthorized)
		return
	}
	query, queryErr := url.ParseQuery(r.URL.RawQuery)
	if queryErr != nil || len(query["token"]) != 0 {
		accessError(w, errAccessUnauthorized.Error(), http.StatusUnauthorized)
		return
	}
	if !accessAuth.ensureOwned() {
		accessError(w, "Unable to refresh access session", http.StatusInternalServerError)
		return
	}
	handle, duplicates := accessCookieValue(r, accessRefreshCookie)
	if duplicates || handle == "" {
		accessError(w, errAccessUnauthorized.Error(), http.StatusUnauthorized)
		return
	}
	bundle, err := accessAuth.refresh(handle, accessClientIP(r.RemoteAddr), accessAuth.now())
	if err != nil {
		switch {
		case errors.Is(err, errAccessRefreshLimit):
			w.Header().Set("Retry-After", strconv.Itoa(accessRefreshRetryAfterSeconds))
			accessError(w, "Too many refresh requests", http.StatusTooManyRequests)
		case errors.Is(err, errAccessPersistence):
			accessError(w, "Unable to refresh access session", http.StatusInternalServerError)
		default:
			accessError(w, errAccessUnauthorized.Error(), http.StatusUnauthorized)
		}
		return
	}
	setAccessV2Cookies(w, r, bundle, secure)
	writeAccessV2Bundle(w, bundle)
}

func handleAccessV2Logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		accessMethodNotAllowed(w, http.MethodPost)
		return
	}
	secure, ok := accessV2Allowed(w, r)
	if !ok {
		return
	}
	all, ok := accessDecodeLogoutBody(w, r)
	if !ok || !accessJSONContentType(r) {
		accessError(w, "Invalid logout request", http.StatusBadRequest)
		return
	}
	// Logout is bearer-authorized even with authentication disabled: neither
	// v2 cookie may authorize it.
	credential := accessCredentialFromRequest(r)
	credential.Cookie = ""
	credential.Asset = ""
	credential.AssetState = accessCredentialNone
	if credential.State != accessCredentialPresent {
		accessError(w, errAccessUnauthorized.Error(), http.StatusUnauthorized)
		return
	}
	if !accessAuth.ensureOwned() {
		accessError(w, "Unable to logout", http.StatusInternalServerError)
		return
	}
	if err := accessAuth.logoutBearer(credential.Token, all, accessAuth.now()); err != nil {
		if errors.Is(err, errAccessUnauthorized) {
			accessError(w, errAccessUnauthorized.Error(), http.StatusUnauthorized)
			return
		}
		accessError(w, "Unable to logout", http.StatusInternalServerError)
		return
	}
	clearAccessV2Cookies(w, secure)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// logoutBearer re-validates the bearer under the same lock that revokes its
// family, so a concurrent rotation cannot revoke something else.
func (m *accessAuthManager) logoutBearer(token string, all bool, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.owned {
		return errAccessPersistence
	}
	claims, ok := m.jwtClaimsLocked(token, now, accessJWTClockAllowance)
	if !ok {
		return errAccessUnauthorized
	}
	return m.logoutLocked(claims, all, now)
}

// accessJSONContentType requires application/json, with an optional UTF-8
// charset. Form posts and missing types are refused before any body work.
func accessJSONContentType(r *http.Request) bool {
	contentType := r.Header.Get("Content-Type")
	if len(r.Header.Values("Content-Type")) != 1 {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "application/json" {
		return false
	}
	return true
}

// decodeAccessPasswordBody reads the one v2 password request shape: a JSON
// object with a single string password field. Unknown fields, duplicate keys,
// null, missing values, non-strings, and trailing JSON are rejected.
func decodeAccessPasswordBody(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, accessPasswordBodyLimit))
	if err != nil {
		return "", false
	}
	members, err := scanAccessJSONObject(raw)
	if err != nil || !accessJWTHasExactKeys(members, "password") {
		return "", false
	}
	var password *string
	if err := json.Unmarshal(members["password"], &password); err != nil || password == nil {
		return "", false
	}
	return *password, true
}

// accessMethodNotAllowed answers a wrong method with the Allow header the
// contract requires, so a client can correct itself.
func accessMethodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	accessError(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// accessError writes a plain-text error with the shared no-store policy.
func accessError(w http.ResponseWriter, body string, status int) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body+"\n")
}

// accessDecodeEmptyBody accepts exactly one empty JSON object, with no trailing
// value, within the small-body limit.
func accessDecodeEmptyBody(w http.ResponseWriter, r *http.Request) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, accessRefreshBodyLimit))
	if err != nil {
		return false
	}
	members, err := scanAccessJSONObject(raw)
	if err != nil || len(members) != 0 {
		return false
	}
	return true
}

// accessDecodeLogoutBody requires the exact object {"all":<bool>}.
func accessDecodeLogoutBody(w http.ResponseWriter, r *http.Request) (bool, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, accessRefreshBodyLimit))
	if err != nil {
		return false, false
	}
	members, err := scanAccessJSONObject(raw)
	if err != nil || !accessJWTHasExactKeys(members, "all") {
		return false, false
	}
	var all *bool
	if err := json.Unmarshal(members["all"], &all); err != nil || all == nil {
		return false, false
	}
	return *all, true
}

// writeAccessV2Bundle emits the credential bundle shape exactly.
func writeAccessV2Bundle(w http.ResponseWriter, bundle accessV2Bundle) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"token":                       bundle.Token,
		"expires_at":                  bundle.ExpiresAt,
		"expires_in":                  bundle.ExpiresIn,
		"refresh_idle_expires_at":     bundle.RefreshIdleExpiresAt,
		"refresh_absolute_expires_at": bundle.RefreshAbsoluteExpiresAt,
	})
}

// writeEnabledAccessV2Bundle is the set/change response: the enabled flag plus
// the same bundle fields.
func writeEnabledAccessV2Bundle(w http.ResponseWriter, bundle accessV2Bundle) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled":                     true,
		"token":                       bundle.Token,
		"expires_at":                  bundle.ExpiresAt,
		"expires_in":                  bundle.ExpiresIn,
		"refresh_idle_expires_at":     bundle.RefreshIdleExpiresAt,
		"refresh_absolute_expires_at": bundle.RefreshAbsoluteExpiresAt,
	})
}

// setAccessV2Cookies installs both v2 cookies after the state that backs them is
// durable. The refresh handle is scoped to the refresh path and the access token
// to /api, so neither is sent with ordinary page or mutation traffic.
func setAccessV2Cookies(w http.ResponseWriter, r *http.Request, bundle accessV2Bundle, secure bool) {
	if bundle.RefreshHandle != "" {
		idle := time.Unix(bundle.RefreshIdleExpiresAt, 0)
		http.SetCookie(w, &http.Cookie{
			Name:     accessRefreshCookie,
			Value:    bundle.RefreshHandle,
			Path:     accessRefreshCookiePath,
			Expires:  idle,
			MaxAge:   accessRemainingSeconds(idle, r),
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteStrictMode,
		})
	}
	if bundle.Token != "" {
		expires := time.Unix(bundle.ExpiresAt, 0)
		http.SetCookie(w, &http.Cookie{
			Name:     accessAssetCookie,
			Value:    bundle.Token,
			Path:     accessAssetCookiePath,
			Expires:  expires,
			MaxAge:   accessRemainingSeconds(expires, r),
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteStrictMode,
		})
	}
}

func clearAccessV2Cookies(w http.ResponseWriter, secure bool) {
	for _, cookie := range []struct {
		name string
		path string
	}{
		{accessRefreshCookie, accessRefreshCookiePath},
		{accessAssetCookie, accessAssetCookiePath},
	} {
		http.SetCookie(w, &http.Cookie{
			Name:     cookie.name,
			Value:    "",
			Path:     cookie.path,
			Expires:  time.Unix(1, 0),
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteStrictMode,
		})
	}
}

// accessRemainingSeconds is the cookie Max-Age for an absolute deadline. The
// contract allows no clock-skew extension, so a deadline already in the past
// deletes the cookie on the next request instead of extending it.
func accessRemainingSeconds(deadline time.Time, r *http.Request) int {
	seconds := int(time.Until(deadline).Seconds())
	if seconds < 1 {
		return 1
	}
	return seconds
}

// --- v2 request hardening ------------------------------------------------

const accessRefreshRetryAfterSeconds = 60

// accessV2Allowed applies the route-local checks shared by the four v2 POST
// routes. It reports whether the cookies must carry Secure, which follows the
// origin that was actually validated rather than r.Host: a proxy may forward
// Host: 127.0.0.1:7070 for a browser at https://phi.example.
func accessV2Allowed(w http.ResponseWriter, r *http.Request) (secure bool, ok bool) {
	origins, originsErr := accessConfiguredOrigins()
	if len(r.Header.Values(accessV2Header)) != 1 || !strings.EqualFold(r.Header.Get(accessV2Header), accessV2HeaderValue) {
		accessError(w, "forbidden", http.StatusForbidden)
		return false, false
	}
	if err := accessCheckFetchSite(r); err != nil {
		accessError(w, "forbidden", http.StatusForbidden)
		return false, false
	}
	secure, err := accessCheckOrigin(r, origins, originsErr)
	if err != nil {
		accessError(w, "forbidden", http.StatusForbidden)
		return false, false
	}
	return secure, true
}

// accessCheckFetchSite rejects a present fetch metadata that says the request
// did not come from this origin. A duplicated header is refused outright: the
// existing compact-route helper reads through Get and would accept one of them.
func accessCheckFetchSite(r *http.Request) error {
	values := r.Header.Values("Sec-Fetch-Site")
	if len(values) == 0 {
		return nil
	}
	if len(values) != 1 {
		return errors.New("duplicate fetch metadata")
	}
	switch values[0] {
	case "same-origin", "none":
		return nil
	}
	return errors.New("cross-origin fetch metadata")
}

// accessCheckOrigin validates the presented Origin against the request's own
// origin or the configured extras. An absent Origin is allowed: native hosts and
// CLI callers have none, and they already sent the custom header and JSON.
func accessCheckOrigin(r *http.Request, origins []string, originsErr error) (secure bool, err error) {
	values := r.Header.Values("Origin")
	if len(values) == 0 {
		// No origin to validate, so the transport decides. A TLS request is
		// already secure, and a configured https origin covers a proxy hop that
		// terminated TLS for an origin-less client.
		return r.TLS != nil || accessOriginsRequireTLS(origins), nil
	}
	if len(values) != 1 {
		return false, errors.New("duplicate origin")
	}
	if originsErr != nil {
		return false, originsErr
	}
	presented, scheme, err := accessCanonicalOrigin(values[0])
	if err != nil {
		return false, err
	}
	if self, _ := accessSelfOrigin(r); self != "" && self == presented {
		return scheme == "https", nil
	}
	for _, entry := range origins {
		if entry == presented {
			return scheme == "https", nil
		}
	}
	return false, errors.New("origin not allowed")
}

// accessOriginsRequireTLS is the conservative direction for a request with no
// Origin: a native client ignores Secure, so marking cookies Secure whenever any
// configured origin is https costs those clients nothing.
func accessOriginsRequireTLS(origins []string) bool {
	for _, entry := range origins {
		if strings.HasPrefix(entry, "https://") {
			return true
		}
	}
	return false
}

// accessSelfOrigin is the origin this request arrived on, derived only from the
// transport and Host: forwarded scheme/host headers stay ignored.
func accessSelfOrigin(r *http.Request) (string, string) {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host, err := accessCanonicalHost(scheme, r.Host)
	if err != nil {
		return "", ""
	}
	return scheme + "://" + host, scheme
}

// accessCanonicalOrigin normalizes one absolute http(s) origin. Anything with a
// path, query, fragment, userinfo, opaque form, wildcard, or other scheme is a
// configuration or request error rather than a near miss.
func accessCanonicalOrigin(raw string) (origin, scheme string, err error) {
	if raw == "" || raw == "null" {
		return "", "", errors.New("invalid origin")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", "", errors.New("invalid origin")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", "", errors.New("unsupported origin scheme")
	}
	if parsed.Opaque != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", errors.New("invalid origin")
	}
	if parsed.Path != "" || parsed.RawPath != "" {
		return "", "", errors.New("invalid origin")
	}
	host, err := accessCanonicalHost(parsed.Scheme, parsed.Host)
	if err != nil {
		return "", "", err
	}
	return parsed.Scheme + "://" + host, parsed.Scheme, nil
}

// accessCanonicalHost lowercases the host and drops the default port for its
// scheme, so an equivalent origin compares equal to its configured entry.
func accessCanonicalHost(scheme, host string) (string, error) {
	if host == "" || strings.ContainsAny(host, "* ") {
		return "", errors.New("invalid origin host")
	}
	hostname := host
	port := ""
	if splitHost, splitPort, err := net.SplitHostPort(host); err == nil {
		hostname, port = splitHost, splitPort
	} else if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		hostname = host
	}
	if port != "" {
		if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
			port = ""
		}
	}
	hostname = strings.ToLower(hostname)
	if port != "" {
		return hostname + ":" + port, nil
	}
	return hostname, nil
}

// accessConfiguredOrigins canonicalizes auth_origins once per distinct value.
// A malformed entry is an error, never a silent skip: the request is refused and
// startup validation reports it.
var accessOriginsCache struct {
	mu      sync.Mutex
	raw     string
	origins []string
	err     error
}

func accessConfiguredOrigins() ([]string, error) {
	configured := loadConfig().AuthOrigins
	raw := strings.Join(configured, "\n")
	accessOriginsCache.mu.Lock()
	defer accessOriginsCache.mu.Unlock()
	if accessOriginsCache.raw == raw && (accessOriginsCache.origins != nil || accessOriginsCache.err != nil) {
		return accessOriginsCache.origins, accessOriginsCache.err
	}
	origins, err := canonicalizeAccessOrigins(configured)
	accessOriginsCache.raw, accessOriginsCache.origins, accessOriginsCache.err = raw, origins, err
	return origins, err
}

// canonicalizeAccessOrigins validates the configured list. Duplicates collapse;
// anything that is not an exact canonical origin fails.
func canonicalizeAccessOrigins(configured []string) ([]string, error) {
	if len(configured) == 0 {
		return nil, nil
	}
	seen := make(map[string]bool, len(configured))
	origins := make([]string, 0, len(configured))
	for _, entry := range configured {
		canonical, _, err := accessCanonicalOrigin(entry)
		if err != nil {
			return nil, fmt.Errorf("invalid auth_origins entry: %w", err)
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		origins = append(origins, canonical)
	}
	return origins, nil
}

// validateOrigins reports a malformed auth_origins list so startup can refuse to
// run with a configuration that would silently 403 every browser.
func (m *accessAuthManager) validateOrigins() error {
	_, err := accessConfiguredOrigins()
	return err
}

func setAccessSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     accessSessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  time.Now().Add(accessSessionTTL),
		MaxAge:   int(accessSessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearAccessSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     accessSessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
