package phic

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

// desktopStore edits the desktop's actual document, not a second native-client
// store. Each mutation reads the latest file so desktop edits and preferences
// are not replaced with an old in-memory snapshot.
type desktopStore struct{ path string }

type desktopDocument struct {
	fields map[string]json.RawMessage
	rows   []map[string]json.RawMessage
}

func jsonString(value json.RawMessage) string {
	var s string
	_ = json.Unmarshal(value, &s)
	return s
}

func (d *desktopDocument) profiles() []desktopProfile {
	out := make([]desktopProfile, 0, len(d.rows))
	for _, row := range d.rows {
		p := desktopProfile{ID: jsonString(row["id"]), Name: jsonString(row["name"]), Origin: jsonString(row["origin"]), LastUsed: jsonString(row["lastUsed"])}
		if p.Name == "" {
			p.Name = p.Origin
		}
		out = append(out, p)
	}
	return out
}

func parseDesktopDocument(data []byte) (*desktopDocument, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, fmt.Errorf("invalid desktop profile document")
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(fields["profiles"], &entries); err != nil || entries == nil {
		return nil, fmt.Errorf("invalid desktop profile list")
	}
	d := &desktopDocument{fields: fields, rows: make([]map[string]json.RawMessage, 0, len(entries))}
	seen := map[string]bool{}
	for _, entry := range entries {
		var row map[string]json.RawMessage
		if json.Unmarshal(entry, &row) != nil {
			continue
		}
		id, origin := jsonString(row["id"]), jsonString(row["origin"])
		if id == "" || origin == "" || seen[id] {
			continue
		}
		seen[id] = true
		d.rows = append(d.rows, row)
	}
	return d, nil
}

func emptyDesktopDocument() *desktopDocument {
	d, _ := parseDesktopDocument([]byte(`{"profiles":[],"closeToTray":true,"syncAlerts":true,"lowMemoryMode":false,"petEnabled":false,"petZoomPercent":100,"contentZoomPercent":100,"petIdleDwellSeconds":10}`))
	return d
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
	rows, err := json.Marshal(d.rows)
	if err != nil {
		return err
	}
	d.fields["profiles"] = rows
	data, err := json.MarshalIndent(d.fields, "", "  ")
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
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", err
	}
	if (u.Scheme != "http" && u.Scheme != "https") || !strings.Contains(raw, "://") || u.Host == "" || u.User != nil || strings.ContainsAny(raw, "?#") || (u.Path != "" && u.Path != "/") {
		return "", "", fmt.Errorf("phic: server must be an HTTP(S) origin without credentials, path, query, or fragment")
	}
	hostname := strings.ToLower(u.Hostname())
	if strings.Contains(hostname, ":") {
		ip := net.ParseIP(hostname)
		if ip == nil {
			return "", "", fmt.Errorf("phic: invalid server hostname")
		}
		hostname = "[" + ip.String() + "]"
	} else {
		if !desktopHostname.MatchString(hostname) {
			hostname, err = idna.Lookup.ToASCII(hostname)
		}
		if err != nil || !desktopHostname.MatchString(hostname) {
			return "", "", fmt.Errorf("phic: invalid server hostname")
		}
	}
	host = hostname
	if strings.HasSuffix(u.Host, ":") {
		return "", "", fmt.Errorf("phic: empty server port")
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return "", "", fmt.Errorf("phic: invalid server port")
		}
		host += ":" + port
	}
	return u.Scheme + "://" + host + "/", host, nil
}

func (s *desktopStore) add(raw string) (desktopProfile, error) {
	origin, host, err := desktopEndpoint(raw)
	if err != nil {
		return desktopProfile{}, err
	}
	d, err := s.read()
	if err != nil {
		return desktopProfile{}, err
	}
	for _, p := range d.profiles() {
		if p.Origin == origin {
			return p, nil
		}
	}
	id := strings.Trim(profileIDSeparators.ReplaceAllString(strings.ToLower(host), "-"), "-")
	if id == "" {
		id = "server"
	}
	for _, p := range d.profiles() {
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
	d.rows = append(d.rows, row)
	if err := s.save(d); err != nil {
		return desktopProfile{}, err
	}
	return p, nil
}

func validateServerName(name string) error {
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 64 {
		return fmt.Errorf("phic: server name must contain 1–64 characters")
	}
	for _, r := range name {
		if r < 0x20 {
			return fmt.Errorf("phic: server name must not contain control characters")
		}
	}
	return nil
}

func (s *desktopStore) rename(id, name string) error {
	if err := validateServerName(name); err != nil {
		return err
	}
	d, err := s.read()
	if err != nil {
		return err
	}
	for _, row := range d.rows {
		if jsonString(row["id"]) == id {
			row["name"], _ = json.Marshal(name)
			return s.save(d)
		}
	}
	return fmt.Errorf("phic: unknown saved server")
}

func (s *desktopStore) remove(id string) error {
	d, err := s.read()
	if err != nil {
		return err
	}
	for i, row := range d.rows {
		if jsonString(row["id"]) == id {
			d.rows = append(d.rows[:i], d.rows[i+1:]...)
			return s.save(d)
		}
	}
	return fmt.Errorf("phic: unknown saved server")
}

// Same rail semantics as desktop: move immediately before beforeID, or to
// the end when empty. Reordering changes no IDs, origins or runtime panes.
func (s *desktopStore) reorder(id, beforeID string) error {
	d, err := s.read()
	if err != nil {
		return err
	}
	from, to := -1, len(d.rows)
	for i, row := range d.rows {
		if jsonString(row["id"]) == id {
			from = i
		}
		if beforeID != "" && jsonString(row["id"]) == beforeID {
			to = i
		}
	}
	if from < 0 || (beforeID != "" && to == len(d.rows)) {
		return fmt.Errorf("phic: unknown saved server")
	}
	if from == to || from+1 == to {
		return nil
	}
	row := d.rows[from]
	d.rows = append(d.rows[:from], d.rows[from+1:]...)
	if from < to {
		to--
	}
	d.rows = append(d.rows, nil)
	copy(d.rows[to+1:], d.rows[to:])
	d.rows[to] = row
	return s.save(d)
}

func (s *desktopStore) setLastUsed(id string) error {
	d, err := s.read()
	if err != nil {
		return err
	}
	for _, row := range d.rows {
		if jsonString(row["id"]) == id {
			row["lastUsed"], _ = json.Marshal(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
			return s.save(d)
		}
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
	paths := desktopProfilePaths(dir)
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
