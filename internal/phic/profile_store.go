package phic

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	whatwg "github.com/nlnwa/whatwg-url/url"

	"github.com/hypernewbie/phi/internal/phiprofiles"
)

// desktopStore edits the desktop's actual document, not a second native-client
// store. Each mutation reads the latest file so desktop edits and preferences
// are not replaced with an old in-memory snapshot.
type desktopStore struct{ path string }

var desktopMutationLocks sync.Map

func (s *desktopStore) lockMutation() func() {
	path, _ := filepath.Abs(s.path)
	v, _ := desktopMutationLocks.LoadOrStore(path, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// desktopDocument is phiprofiles.Document: one parser shared with the
// desktop path and phi-cmd. phic mutates it through the exported
// accessors below.
type desktopDocument = phiprofiles.Document

func jsonString(value json.RawMessage) string {
	var s string
	_ = json.Unmarshal(value, &s)
	return s
}

func parseDesktopDocument(data []byte) (*desktopDocument, error) {
	return phiprofiles.Parse(data)
}

func emptyDesktopDocument() *desktopDocument {
	return phiprofiles.Empty()
}

func (s *desktopStore) read() (*desktopDocument, error) {
	for _, file := range []string{s.path, s.path + ".bak"} {
		data, err := os.ReadFile(file)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if d, err := parseDesktopDocument(data); err == nil {
			if file != s.path {
				if err := s.save(d); err != nil {
					return nil, err
				}
			}
			return d, nil
		}
		// Like desktop, keep corrupt input for diagnostics rather than silently
		// overwriting it or replacing the good backup with corrupt bytes.
		aside, err := os.CreateTemp(filepath.Dir(file), filepath.Base(file)+".corrupt-*")
		if err != nil {
			return nil, err
		}
		name := aside.Name()
		_ = aside.Close()
		if err := os.Rename(file, name); err != nil {
			_ = os.Remove(name)
			return nil, err
		}
	}
	return emptyDesktopDocument(), nil
}

func (s *desktopStore) save(d *desktopDocument) error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	rows, err := json.Marshal(d.Rows())
	if err != nil {
		return err
	}
	d.Fields()["profiles"] = rows
	data, err := json.MarshalIndent(d.Fields(), "", "  ")
	if err != nil {
		return err
	}
	// Same desktop backup + synced temporary file + atomic rename contract.
	if previous, err := os.ReadFile(s.path); err == nil {
		if err := os.WriteFile(s.path+".bak", previous, 0600); err != nil {
			return fmt.Errorf("phic: backup desktop profiles: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.CreateTemp(dir, "profiles.json.tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = writeAll(f, data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(f.Name(), s.path); err != nil {
		return err
	}
	return nil
}

var desktopHostname = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?)*\.?$`)
var profileIDSeparators = regexp.MustCompile(`[^a-z0-9]+`)

// Desktop endpoint.Parse form: lowercase host, preserved explicit port,
// trailing root slash, and no credentials, query, fragment or non-root path.
func desktopEndpoint(raw string) (origin, host string, err error) {
	u, parseErr := whatwg.Parse(raw)
	if parseErr != nil {
		return "", "", fmt.Errorf("invalid server URL %q", raw)
	}
	fail := func(message string) (string, string, error) {
		return "", "", fmt.Errorf("server URL \"%s\" %s", raw, message)
	}
	if u.Scheme() != "http" && u.Scheme() != "https" {
		return fail("must use the http or https scheme")
	}
	authority := serverScheme.FindString(raw)
	if authority != "" {
		authority = raw[len(authority):]
		if i := strings.IndexAny(authority, "/?#"); i >= 0 {
			authority = authority[:i]
		}
	}
	if u.Hostname() == "" || authority == "" {
		return fail("has no hostname")
	}
	hostname := u.Hostname()
	valid := desktopHostname.MatchString(hostname)
	if strings.Contains(hostname, ":") {
		valid = net.ParseIP(strings.Trim(hostname, "[]")) != nil
	}
	if !valid {
		return fail("has an invalid hostname")
	}
	if u.Username() != "" || u.Password() != "" {
		return fail("must not contain userinfo")
	}
	if strings.Contains(raw, "?") {
		return fail("must not contain a query string")
	}
	if strings.Contains(raw, "#") {
		return fail("must not contain a fragment")
	}
	if u.Pathname() != "/" {
		return fail("must use the root path (Phi serves /api and /ws at the origin)")
	}
	host = hostname
	if strings.HasSuffix(authority, ":") {
		return fail("has an empty port")
	}
	colon, bracket := strings.LastIndex(authority, ":"), strings.LastIndex(authority, "]")
	if colon > bracket {
		port := authority[colon+1:]
		if decimalPort.MatchString(port) {
			n, e := strconv.Atoi(port)
			if e != nil || n < 1 || n > 65535 {
				return fail("has an invalid port \"" + port + "\"")
			}
			host += ":" + port
		}
	}
	return u.Scheme() + "://" + host + "/", host, nil
}

func (s *desktopStore) add(raw string) (desktopProfile, error) {
	defer s.lockMutation()()
	origin, host, err := desktopEndpoint(raw)
	if err != nil {
		return desktopProfile{}, err
	}
	d, err := s.read()
	if err != nil {
		return desktopProfile{}, err
	}
	for _, p := range d.Profiles() {
		if p.Origin == origin {
			return p, nil
		}
	}
	id := strings.Trim(profileIDSeparators.ReplaceAllString(strings.ToLower(host), "-"), "-")
	if id == "" {
		id = "server"
	}
	for _, p := range d.Profiles() {
		if p.ID == id {
			digest := fmt.Sprintf("%x", sha256.Sum256([]byte(origin)))
			id += "-" + digest[:6]
			break
		}
	}
	p := desktopProfile{ID: id, Name: host, Origin: origin}
	data, _ := json.Marshal(p)
	var row map[string]json.RawMessage
	_ = json.Unmarshal(data, &row)
	d.AppendRow(row)
	if err := s.save(d); err != nil {
		return desktopProfile{}, err
	}
	return p, nil
}

func validateServerName(name string) error {
	if jsTrim(name) == "" {
		return fmt.Errorf("profile name must not be empty")
	}
	if utf8.RuneCountInString(name) > 64 {
		return fmt.Errorf("profile name must be at most 64 runes")
	}
	for _, r := range name {
		if r < 0x20 {
			return fmt.Errorf("profile name must not contain control characters")
		}
	}
	return nil
}

func (s *desktopStore) rename(id, name string) error {
	defer s.lockMutation()()
	if err := validateServerName(name); err != nil {
		return err
	}
	d, err := s.read()
	if err != nil {
		return err
	}
	row, ok := d.Row(id)
	if !ok {
		return fmt.Errorf("phic: unknown saved server")
	}
	row["name"], _ = json.Marshal(name)
	return s.save(d)
}

func (s *desktopStore) remove(id string) error {
	defer s.lockMutation()()
	d, err := s.read()
	if err != nil {
		return err
	}
	if !d.RemoveRowByID(id) {
		return fmt.Errorf("phic: unknown saved server")
	}
	return s.save(d)
}

// Same rail semantics as desktop: move immediately before beforeID, or to
// the end when empty. Reordering changes no IDs, origins or runtime panes.
func (s *desktopStore) reorder(id, beforeID string) error {
	defer s.lockMutation()()
	d, err := s.read()
	if err != nil {
		return err
	}
	found, beforeFound := d.MoveRowBefore(id, beforeID)
	if !found || (beforeID != "" && !beforeFound) {
		return fmt.Errorf("phic: unknown saved server")
	}
	return s.save(d)
}

func (s *desktopStore) setLastUsed(id string) error {
	defer s.lockMutation()()
	d, err := s.read()
	if err != nil {
		return err
	}
	if row, ok := d.Row(id); ok {
		row["lastUsed"], _ = json.Marshal(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
		return s.save(d)
	}
	// Another client may have removed this profile. Never resurrect it just
	// because an already attached pane is still running.
	return nil
}

func desktopStoreFor(cfg config) (*desktopStore, error) {
	if cfg.Profiles != "" {
		return &desktopStore{path: cfg.Profiles}, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	paths := phiprofiles.Paths(dir)
	store := &desktopStore{path: paths[0]}
	if _, err := os.Stat(store.path); err == nil {
		return store, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if _, err := os.Stat(store.path + ".bak"); err == nil {
		return store, nil
	}
	// Match Electron's migration into phi-client, not a writable fork in a
	// legacy directory that Electron will stop reading after migration.
	for _, legacy := range paths[1:] {
		data, err := os.ReadFile(legacy)
		if errors.Is(err, os.ErrNotExist) {
			data, err = os.ReadFile(legacy + ".bak")
		}
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(store.path), 0700); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(store.path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(err, os.ErrExist) {
			return store, nil
		}
		if err != nil {
			return nil, err
		}
		err = writeAll(f, data)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if backup, err := os.ReadFile(legacy + ".bak"); err == nil {
			if err := os.WriteFile(store.path+".bak", backup, 0600); err != nil {
				return nil, err
			}
		}
		break
	}
	return store, nil
}
