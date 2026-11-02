package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/hypernewbie/phi/internal/config"
)

// resolvedSessionListPageSize defaults 0 (unset) to 10 and clamps every other
// value to 5..100. The sidebar reads the resolved number, so the range lives
// in one place.
func resolvedSessionListPageSize(size int) int {
	switch {
	case size == 0:
		return 10
	case size < 5:
		return 5
	case size > 100:
		return 100
	default:
		return size
	}
}

func (app *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := app.loadConfig()
	hName := strings.ToUpper(ReportedHostname(cfg))
	addr, _ := r.Context().Value(http.LocalAddrContextKey).(*net.TCPAddr)
	if addr == nil {
		addr = &net.TCPAddr{Port: app.port}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"workspaces":                          cfg.Workspaces,
		"active_cwd":                          app.activeCWD,
		"theme_color":                         cfg.ThemeColor,
		"hostname":                            hName,
		"model_presets":                       cfg.ModelPresets,
		"thinking_presets":                    cfg.ThinkingPresets,
		"quick_commands":                      cfg.QuickCommands,
		"terminal_commands":                   cfg.TerminalCommands,
		"markdown_dirs":                       cfg.MarkdownDirs,
		"use_existing_terminal_tab":           cfg.UseExistingTerminalTab,
		"use_hidden_terminal":                 cfg.UseHiddenTerminal,
		"fast_mode":                           cfg.FastMode,
		"pi_offline":                          cfg.PiOffline,
		"pi_bridge_no_inject":                 cfg.PiBridgeNoInject,
		"opencode_legacy":                     cfg.OpenCodeLegacy,
		"claude_dangerously_skip_permissions": cfg.ClaudeDangerouslySkipPermissions,
		"agy_theme_ansi":                      cfg.AgyThemeAnsi,
		"auto_reconnect":                      cfg.AutoReconnect,
		"sync_coordinator":                    cfg.SyncCoordinatorURL(addr),
		"ui_font_family":                      cfg.UIFontFamily,
		"ui_font_size":                        cfg.UIFontSize,
		"terminal_font_family":                cfg.TerminalFontFamily,
		"terminal_font_size":                  cfg.TerminalFontSize,
		"session_list_page_size":              resolvedSessionListPageSize(cfg.SessionListPageSize),
		"mobile_scrollback_rows":              cfg.MobileScrollbackRows,
		"hostname_override":                   cfg.HostnameOverride,
		"opencode_idle_stop_minutes":          cfg.OpenCodeIdleStopMinutes,
	})
}

func (app *Server) handleWorkspaceToggle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	path := expandHome(req["path"])
	if path == "" {
		http.Error(w, "Missing path", http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()

	if r.Method == http.MethodPost {
		found := false
		for _, wsPath := range cfg.Workspaces {
			if wsPath == path {
				found = true
				break
			}
		}
		if !found {
			cfg.Workspaces = append(cfg.Workspaces, path)
			app.saveConfig(cfg)
		}
	} else if r.Method == http.MethodDelete {
		newWS := []string{}
		for _, wsPath := range cfg.Workspaces {
			if wsPath != path {
				newWS = append(newWS, wsPath)
			}
		}
		cfg.Workspaces = newWS
		app.saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func (app *Server) handleModelPresets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	model := strings.TrimSpace(req["model"])
	coder := strings.TrimSpace(req["coder"])
	oldModel := strings.TrimSpace(req["old_model"])
	if model == "" {
		http.Error(w, "Missing model", http.StatusBadRequest)
		return
	}
	if coder == "" {
		coder = "pi"
	}

	cfg := app.loadConfig()

	if r.Method == http.MethodPost {
		if cfg.ModelPresets == nil {
			cfg.ModelPresets = make(config.ModelPresetsMap)
		}
		if oldModel != "" {
			for i, m := range cfg.ModelPresets[coder] {
				if m == oldModel {
					cfg.ModelPresets[coder][i] = model
					break
				}
			}
		} else {
			found := false
			for _, m := range cfg.ModelPresets[coder] {
				if m == model {
					found = true
					break
				}
			}
			if !found {
				cfg.ModelPresets[coder] = append(cfg.ModelPresets[coder], model)
			}
		}
		app.saveConfig(cfg)
	} else if r.Method == http.MethodDelete {
		if cfg.ModelPresets != nil {
			newPresets := []string{}
			for _, m := range cfg.ModelPresets[coder] {
				if m != model {
					newPresets = append(newPresets, m)
				}
			}
			cfg.ModelPresets[coder] = newPresets
			app.saveConfig(cfg)
		}
	}

	w.WriteHeader(http.StatusOK)
}

// Thinking presets are the saved fallback levels offered for Pi PTY tabs
// when the bridge, or its thinking capability, is unavailable. The list is
// user-managed and holds only the exact tokens Pi accepts.
var thinkingPresetLevels = []string{
	"off", "minimal", "low", "medium", "high", "xhigh", "max",
}

func validThinkingPreset(level string) bool {
	for _, allowed := range thinkingPresetLevels {
		if level == allowed {
			return true
		}
	}
	return false
}

// validateThinkingPresetList rejects anything that is not a short list of
// exact, distinct tokens: no surrounding whitespace, no case changes, no
// duplicates. The user's order is meaningful and is preserved.
func validateThinkingPresetList(levels []string) ([]string, bool) {
	if len(levels) > len(thinkingPresetLevels) {
		return nil, false
	}
	seen := make(map[string]bool, len(levels))
	out := make([]string, 0, len(levels))
	for _, level := range levels {
		if level != strings.TrimSpace(level) || !validThinkingPreset(level) || seen[level] {
			return nil, false
		}
		seen[level] = true
		out = append(out, level)
	}
	return out, true
}

// handleThinkingPresets owns the saved Thinking fallback list. Reads and
// writes are transactional against the latest config file, so a stale
// in-memory snapshot can never drop the list or another field.
func (app *Server) handleThinkingPresets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg, err := app.configStore().LoadWithError()
		if err != nil {
			http.Error(w, "Failed to read config", http.StatusInternalServerError)
			return
		}
		levels := cfg.ThinkingPresets
		if levels == nil {
			levels = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string][]string{"thinking_presets": levels})
	case http.MethodPut:
		// Read before decoding so an unreadable config stays a 500 even for a
		// malformed body. The write path rereads under the store lock, so a
		// stale snapshot can never drop another field.
		if _, err := app.configStore().ReadAuthoritative(); err != nil {
			http.Error(w, "Failed to read config", http.StatusInternalServerError)
			return
		}
		var req struct {
			ThinkingPresets *[]string `json:"thinking_presets"`
		}
		decoder := json.NewDecoder(r.Body)
		if err := decoder.Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			http.Error(w, "Trailing data after JSON body", http.StatusBadRequest)
			return
		}
		if req.ThinkingPresets == nil {
			http.Error(w, "Missing thinking_presets", http.StatusBadRequest)
			return
		}
		levels, ok := validateThinkingPresetList(*req.ThinkingPresets)
		if !ok {
			http.Error(w, "Invalid thinking preset list", http.StatusBadRequest)
			return
		}
		if _, err := app.configStore().Update(func(cfg *config.Config) error {
			cfg.ThinkingPresets = levels
			return nil
		}); err != nil {
			http.Error(w, "Failed to write config", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string][]string{"thinking_presets": levels})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (app *Server) handleQuickCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()

	if r.Method == http.MethodPost {
		// Try parsing as slice/array first for bulk overwrite
		var listReq []config.QuickCommand
		if err := json.Unmarshal(bodyBytes, &listReq); err == nil {
			cfg.QuickCommands = listReq
			app.saveConfig(cfg)
			w.WriteHeader(http.StatusOK)
			return
		}

		// Try parsing as a single quick command
		var singleReq struct {
			OldName string `json:"old_name"`
			Name    string `json:"name"`
			Command string `json:"command"`
		}
		if err := json.Unmarshal(bodyBytes, &singleReq); err != nil {
			http.Error(w, "Invalid payload format. Expected single command or list of commands.", http.StatusBadRequest)
			return
		}
		if singleReq.Name == "" {
			http.Error(w, "Missing name", http.StatusBadRequest)
			return
		}
		if singleReq.Command == "" {
			http.Error(w, "Missing command", http.StatusBadRequest)
			return
		}

		found := false
		targetName := singleReq.OldName
		if targetName == "" {
			targetName = singleReq.Name
		}
		for i, qc := range cfg.QuickCommands {
			if qc.Name == targetName {
				cfg.QuickCommands[i] = config.QuickCommand{Name: singleReq.Name, Command: singleReq.Command}
				found = true
				break
			}
		}
		if !found {
			cfg.QuickCommands = append(cfg.QuickCommands, config.QuickCommand{Name: singleReq.Name, Command: singleReq.Command})
		}
		app.saveConfig(cfg)
	} else if r.Method == http.MethodDelete {
		var singleReq struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(bodyBytes, &singleReq); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if singleReq.Name == "" {
			http.Error(w, "Missing name", http.StatusBadRequest)
			return
		}

		newCmds := []config.QuickCommand{}
		for _, qc := range cfg.QuickCommands {
			if qc.Name != singleReq.Name {
				newCmds = append(newCmds, qc)
			}
		}
		cfg.QuickCommands = newCmds
		app.saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func (app *Server) handleTerminalCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()

	if r.Method == http.MethodPost {
		// Try parsing as slice/array first for bulk overwrite
		var listReq []config.QuickCommand
		if err := json.Unmarshal(bodyBytes, &listReq); err == nil {
			cfg.TerminalCommands = listReq
			app.saveConfig(cfg)
			w.WriteHeader(http.StatusOK)
			return
		}

		// Try parsing as a single terminal command
		var singleReq struct {
			OldName string `json:"old_name"`
			Name    string `json:"name"`
			Command string `json:"command"`
		}
		if err := json.Unmarshal(bodyBytes, &singleReq); err != nil {
			http.Error(w, "Invalid payload format. Expected single command or list of commands.", http.StatusBadRequest)
			return
		}
		if singleReq.Name == "" {
			http.Error(w, "Missing name", http.StatusBadRequest)
			return
		}
		if singleReq.Command == "" {
			http.Error(w, "Missing command", http.StatusBadRequest)
			return
		}

		found := false
		targetName := singleReq.OldName
		if targetName == "" {
			targetName = singleReq.Name
		}
		for i, tc := range cfg.TerminalCommands {
			if tc.Name == targetName {
				cfg.TerminalCommands[i] = config.QuickCommand{Name: singleReq.Name, Command: singleReq.Command}
				found = true
				break
			}
		}
		if !found {
			cfg.TerminalCommands = append(cfg.TerminalCommands, config.QuickCommand{Name: singleReq.Name, Command: singleReq.Command})
		}
		app.saveConfig(cfg)
	} else if r.Method == http.MethodDelete {
		var singleReq struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(bodyBytes, &singleReq); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if singleReq.Name == "" {
			http.Error(w, "Missing name", http.StatusBadRequest)
			return
		}

		newCmds := []config.QuickCommand{}
		for _, tc := range cfg.TerminalCommands {
			if tc.Name != singleReq.Name {
				newCmds = append(newCmds, tc)
			}
		}
		cfg.TerminalCommands = newCmds
		app.saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func (app *Server) handleThemeUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	color := req["color"]
	if color == "" {
		http.Error(w, "Missing color", http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	cfg.ThemeColor = color
	app.saveConfig(cfg)

	w.WriteHeader(http.StatusOK)
}

// sanitizeHostnameOverride validates the hostname_override DISPLAY
// LABEL. It is not a hostname — it never touches a socket URL, so any
// short printable text is fine: a machine nickname ("dusty_potato"),
// a codename ("europa"), even a Japanese haiku. Only length and
// control characters are checked: it rides in JSON payloads, HTML
// escapes, and notification titles, so newlines/control bytes would
// be at best rendered oddly and at worst injection surface. Blank
// clears back to the OS hostname.
func sanitizeHostnameOverride(v string) (string, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "", true
	}
	if len(v) > 64 {
		return "", false
	}
	for _, r := range v {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	return v, true
}

// MaxMobileAppearanceRevision caps the revision at the JS safe integer.
const MaxMobileAppearanceRevision uint64 = 9007199254740991

type MobileAppearanceState struct {
	Revision           uint64  `json:"revision"`
	UIFontSize         *int    `json:"ui_font_size"`
	TerminalFontSize   *int    `json:"terminal_font_size"`
	UIFontFamily       *string `json:"ui_font_family"`
	TerminalFontFamily *string `json:"terminal_font_family"`
}

// MobileAppearanceFromConfig projects the stored appearance fields.
func MobileAppearanceFromConfig(cfg config.Config) MobileAppearanceState {
	return MobileAppearanceState{cfg.MobileAppearanceRevision, cfg.MobileUIFontSize,
		cfg.MobileTerminalFontSize, cfg.MobileUIFontFamily, cfg.MobileTerminalFontFamily}
}

func (app *Server) handleMobileAppearance(w http.ResponseWriter, r *http.Request) {
	app.serveMobileAppearance(w, r, false, app.configStore().Update)
}

func (app *Server) handleMobileAppearanceFence(w http.ResponseWriter, r *http.Request) {
	app.serveMobileAppearance(w, r, true, app.configStore().Update)
}

// Revision outcomes the writer reports back so the handler can map them to
// status codes. A conflict still returns the current state with 409.
var (
	errMobileAppearanceConflict  = errors.New("mobile appearance revision conflict")
	errMobileAppearanceInvalid   = errors.New("invalid stored mobile appearance revision")
	errMobileAppearanceExhausted = errors.New("mobile appearance revision exhausted")
)

// The update argument permits deterministic disk-failure tests without a global hook.
// serveMobileAppearance serves /api/config/mobile-appearance with the
// caller-supplied update path so the fence and prefetch variants share one
// implementation.
func (app *Server) serveMobileAppearance(w http.ResponseWriter, r *http.Request, fence bool, update func(func(*config.Config) error) (config.Config, error)) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet && !fence {
		cfg, err := app.configStore().LoadWithError()
		state := MobileAppearanceFromConfig(cfg)
		if err != nil || state.Revision > MaxMobileAppearanceRevision {
			http.Error(w, "Failed to read config", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(state)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "Expected application/json", http.StatusUnsupportedMediaType)
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	var body map[string]json.RawMessage
	decodeErr := decoder.Decode(&body)
	if decodeErr == nil {
		if err := decoder.Decode(new(any)); err != io.EOF {
			if err == nil {
				decodeErr = errors.New("trailing JSON")
			} else {
				decodeErr = err
			}
		}
	}
	if decodeErr != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(decodeErr, &tooLarge) {
			http.Error(w, "Body too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		}
		return
	}
	var revision uint64
	var fields map[string]json.RawMessage
	valid := body != nil
	if fence {
		valid = valid && len(body) == 0
	} else {
		rawRevision := body["revision"]
		valid = valid && len(body) == 2 && len(rawRevision) > 0 && string(rawRevision) != "null" &&
			json.Unmarshal(rawRevision, &revision) == nil && revision <= MaxMobileAppearanceRevision &&
			json.Unmarshal(body["fields"], &fields) == nil && len(fields) > 0
	}
	// Decode the patch before locking. Map presence distinguishes omission from null.
	var patch MobileAppearanceState
	for key, raw := range fields {
		switch key {
		case "ui_font_size", "terminal_font_size":
			var size *int
			if err := json.Unmarshal(raw, &size); err != nil {
				valid = false
			}
			min, max := 10, 24
			if key == "terminal_font_size" {
				min, max = 8, 32
			}
			if size != nil && (*size < min || *size > max) {
				valid = false
			}
			if key == "ui_font_size" {
				patch.UIFontSize = size
			} else {
				patch.TerminalFontSize = size
			}
		case "ui_font_family", "terminal_font_family":
			if !utf8.Valid(raw) {
				valid = false
			}
			var family *string
			if err := json.Unmarshal(raw, &family); err != nil {
				valid = false
			}
			if family != nil && (len(*family) > 512 || !utf8.ValidString(*family) || strings.ContainsFunc(*family, unicode.IsControl)) {
				valid = false
			}
			if key == "ui_font_family" {
				patch.UIFontFamily = family
			} else {
				patch.TerminalFontFamily = family
			}
		default:
			valid = false
		}
	}
	if !valid {
		http.Error(w, "Invalid mobile appearance update", http.StatusBadRequest)
		return
	}

	cfg, err := update(func(cfg *config.Config) error {
		if cfg.MobileAppearanceRevision > MaxMobileAppearanceRevision {
			return errMobileAppearanceInvalid
		}
		if !fence && cfg.MobileAppearanceRevision != revision {
			return errMobileAppearanceConflict
		}
		if cfg.MobileAppearanceRevision == MaxMobileAppearanceRevision {
			return errMobileAppearanceExhausted
		}
		if _, ok := fields["ui_font_size"]; ok {
			cfg.MobileUIFontSize = patch.UIFontSize
		}
		if _, ok := fields["terminal_font_size"]; ok {
			cfg.MobileTerminalFontSize = patch.TerminalFontSize
		}
		if _, ok := fields["ui_font_family"]; ok {
			cfg.MobileUIFontFamily = patch.UIFontFamily
		}
		if _, ok := fields["terminal_font_family"]; ok {
			cfg.MobileTerminalFontFamily = patch.TerminalFontFamily
		}
		cfg.MobileAppearanceRevision++
		return nil
	})
	status := http.StatusOK
	switch {
	case errors.Is(err, errMobileAppearanceConflict):
		status, err = http.StatusConflict, nil
	case errors.Is(err, errMobileAppearanceInvalid), errors.Is(err, errMobileAppearanceExhausted):
		status = http.StatusInternalServerError
	}
	state := MobileAppearanceFromConfig(cfg)
	if err != nil {
		http.Error(w, "Failed to save config", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(state)
}

// handleAppearanceUpdate persists font + UI display settings from the
// Settings modal. POST only. Any field omitted from the request body
// is left unchanged on disk; an empty string clears it (client falls
// back to the built-in default). UIFontSize is clamped to 10..24 to
// prevent rendering breakage.
func (app *Server) handleAppearanceUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	if v, ok := req["ui_font_family"].(string); ok {
		cfg.UIFontFamily = v
	}
	if v, ok := req["terminal_font_family"].(string); ok {
		cfg.TerminalFontFamily = v
	}
	if v, ok := req["ui_font_size"]; ok {
		switch n := v.(type) {
		case float64:
			cfg.UIFontSize = int(n)
		case int:
			cfg.UIFontSize = n
		}
		// Clamp to a sane rendering range. 10 is the smallest size
		// xterm and most browsers still render legibly; 24 is well
		// above accessibility-friendly and below "slideshow".
		if cfg.UIFontSize < 10 {
			cfg.UIFontSize = 10
		}
		if cfg.UIFontSize > 24 {
			cfg.UIFontSize = 24
		}
	}
	if v, ok := req["terminal_font_size"]; ok {
		switch n := v.(type) {
		case float64:
			cfg.TerminalFontSize = int(n)
		case int:
			cfg.TerminalFontSize = n
		}
		if cfg.TerminalFontSize != 0 { // 0 = unset/default, leave as sentinel
			if cfg.TerminalFontSize < 8 {
				cfg.TerminalFontSize = 8
			}
			if cfg.TerminalFontSize > 32 {
				cfg.TerminalFontSize = 32
			}
		}
	}
	if v, ok := req["mobile_scrollback_rows"]; ok {
		switch n := v.(type) {
		case float64:
			cfg.MobileScrollbackRows = int(n)
		case int:
			cfg.MobileScrollbackRows = n
		}
		// 0 = unset/full history. Otherwise clamp to a range that
		// keeps scroll-up useful on small screens without letting a
		// typo brick history.
		if cfg.MobileScrollbackRows != 0 {
			if cfg.MobileScrollbackRows < 500 {
				cfg.MobileScrollbackRows = 500
			}
			if cfg.MobileScrollbackRows > 10000 {
				cfg.MobileScrollbackRows = 10000
			}
		}
	}
	if v, ok := req["hostname_override"].(string); ok {
		// Empty clears back to page-host default. Anything else must
		// sanitize to host[:port]; garbage leaves the stored value
		// unchanged so a typo can never brick connectivity.
		if v == "" {
			cfg.HostnameOverride = ""
		} else if clean, ok := sanitizeHostnameOverride(v); ok {
			cfg.HostnameOverride = clean
		}
	}
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ui_font_family":         cfg.UIFontFamily,
		"ui_font_size":           cfg.UIFontSize,
		"terminal_font_family":   cfg.TerminalFontFamily,
		"terminal_font_size":     cfg.TerminalFontSize,
		"mobile_scrollback_rows": cfg.MobileScrollbackRows,
		"hostname_override":      cfg.HostnameOverride,
	})
}

func (app *Server) handleUseExistingTerminalTab(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	cfg.UseExistingTerminalTab = req.Enabled
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.UseExistingTerminalTab})
}

func (app *Server) handleUseHiddenTerminal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	cfg.UseHiddenTerminal = req.Enabled
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.UseHiddenTerminal})
}

// handleFastMode persists the legacy per-server effects flag. Retained
// for backwards compatibility (old clients, the field in handleConfig);
// current clients store low power mode in the browser (localStorage
// `phi_low_power`) and never call this — a true value here is only a
// one-time migration seed the client adopts locally.
func (app *Server) handleFastMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	cfg.FastMode = req.Enabled
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.FastMode})
}

// handlePiOffline toggles whether the pi coder is spawned with --offline.
// Takes effect on the next spawn: an already-running pi process cannot be
// switched, since the flag is set at exec time.
func (app *Server) handlePiOffline(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	cfg.PiOffline = req.Enabled
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.PiOffline})
}

// handlePiBridgeNoInject toggles whether phi omits --extension when
// spawning the pi coder, for manual bridge installs. Same shape as
// handlePiOffline: takes effect on the next spawn.
func (app *Server) handlePiBridgeNoInject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	cfg.PiBridgeNoInject = req.Enabled
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.PiBridgeNoInject})
}

// handleClaudeDangerouslySkipPermissions toggles whether the claude coder
// is spawned with --dangerously-skip-permissions. Same shape as
// handlePiOffline: takes effect on the next spawn, an already-running
// claude process cannot be switched because the flag is set at exec time.
func (app *Server) handleClaudeDangerouslySkipPermissions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	cfg.ClaudeDangerouslySkipPermissions = req.Enabled
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.ClaudeDangerouslySkipPermissions})
}

// handleAgyThemeAnsi toggles whether xterm's ANSI colour palette dynamically
// matches Phi's active accent theme for agy coder tabs.
func (app *Server) handleAgyThemeAnsi(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	cfg.AgyThemeAnsi = req.Enabled
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.AgyThemeAnsi})
}

// handleAutoReconnect toggles the automatic-reconnect master switch (wake,
// network-restore, and passive backoff redials of the active tab). Stored
// values are "visible" (on) and "off"; the wire contract is {enabled: bool}
// to match the other settings toggles.
func (app *Server) handleAutoReconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	if req.Enabled {
		cfg.AutoReconnect = "visible"
	} else {
		cfg.AutoReconnect = "off"
	}
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.AutoReconnect == "visible"})
}

// handleOpenCodeIdleStop sets the idle timeout in minutes before stopping the
// OpenCode background server. 0 disables the auto-stop. Clamped to 5..1440 when > 0.
func (app *Server) handleOpenCodeIdleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Minutes *int `json:"minutes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Minutes == nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	val := config.NormalizeOpenCodeIdleStopMinutes(*req.Minutes)
	cfg := app.loadConfig()
	cfg.OpenCodeIdleStopMinutes = val
	app.saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"opencode_idle_stop_minutes": cfg.OpenCodeIdleStopMinutes})
}

// encodeConfigData serializes, base64-encodes, hashes, and formats with a prefix.
// EncodeConfigData wraps a config payload in the export envelope.
func EncodeConfigData(prefix string, data interface{}) (string, error) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	b64Payload := base64.StdEncoding.EncodeToString(jsonData)
	const salt = "phi_super_secret_salt_2026"
	hasher := sha256.New()
	hasher.Write([]byte(b64Payload + salt))
	hashHex := hex.EncodeToString(hasher.Sum(nil))
	return fmt.Sprintf("%s:%s:%s", prefix, hashHex, b64Payload), nil
}

// decodeConfigData validates prefix, hash, and decodes the base64 payload.
// DecodeConfigData decodes the exported config payload envelope.
func DecodeConfigData(raw string, expectedPrefix string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, expectedPrefix+":") {
		return nil, fmt.Errorf("invalid configuration format (missing or incorrect sentinel)")
	}
	parts := strings.Split(raw, ":")
	if len(parts) != 3 {
		return nil, fmt.Errorf("malformed configuration string")
	}
	hashHex, b64Payload := parts[1], parts[2]
	const salt = "phi_super_secret_salt_2026"
	hasher := sha256.New()
	hasher.Write([]byte(b64Payload + salt))
	if hashHex != hex.EncodeToString(hasher.Sum(nil)) {
		return nil, fmt.Errorf("configuration signature verification failed (corrupted or altered data)")
	}
	return base64.StdEncoding.DecodeString(b64Payload)
}

func (app *Server) handleConfigExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cfg := app.loadConfig()
	exportData := struct {
		ModelPresets     config.ModelPresetsMap `json:"model_presets"`
		QuickCommands    []config.QuickCommand  `json:"quick_commands"`
		TerminalCommands []config.QuickCommand  `json:"terminal_commands"`
	}{
		ModelPresets:     cfg.ModelPresets,
		QuickCommands:    cfg.QuickCommands,
		TerminalCommands: cfg.TerminalCommands,
	}

	formatted, err := EncodeConfigData("PHICONFIG", exportData)
	if err != nil {
		http.Error(w, "Failed to serialize export data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"config": formatted,
	})
}

func (app *Server) handleConfigImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Config string `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	jsonData, err := DecodeConfigData(req.Config, "PHICONFIG")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var importedData struct {
		ModelPresets     config.ModelPresetsMap `json:"model_presets"`
		QuickCommands    []config.QuickCommand  `json:"quick_commands"`
		TerminalCommands []config.QuickCommand  `json:"terminal_commands"`
	}

	if err := json.Unmarshal(jsonData, &importedData); err != nil {
		http.Error(w, "Failed to parse configuration JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	if importedData.ModelPresets != nil {
		cfg.ModelPresets = importedData.ModelPresets
	}
	if len(importedData.QuickCommands) > 0 {
		cfg.QuickCommands = importedData.QuickCommands
	}
	if len(importedData.TerminalCommands) > 0 {
		cfg.TerminalCommands = importedData.TerminalCommands
	}

	app.saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

func (app *Server) handleConfigExportModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cfg := app.loadConfig()
	exportData := struct {
		ModelPresets config.ModelPresetsMap `json:"model_presets"`
	}{
		ModelPresets: cfg.ModelPresets,
	}

	formatted, err := EncodeConfigData("PHIMODELS", exportData)
	if err != nil {
		http.Error(w, "Failed to serialize export data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"config": formatted,
	})
}

func (app *Server) handleConfigImportModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Config string `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	jsonData, err := DecodeConfigData(req.Config, "PHIMODELS")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var importedData struct {
		ModelPresets config.ModelPresetsMap `json:"model_presets"`
	}

	if err := json.Unmarshal(jsonData, &importedData); err != nil {
		http.Error(w, "Failed to parse configuration JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	if importedData.ModelPresets != nil {
		cfg.ModelPresets = importedData.ModelPresets
	}

	app.saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

// handleConfigExportQuickCommands exports ONLY the quick_commands list (the
// dropup that sends commands to the active PTY). Decoupled from terminal
// commands in v0.7.16 — the two concepts were being conflated under the
// old /api/config/export-cmds endpoint which dumped both.
func (app *Server) handleConfigExportQuickCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cfg := app.loadConfig()
	exportData := struct {
		QuickCommands []config.QuickCommand `json:"quick_commands"`
	}{
		QuickCommands: cfg.QuickCommands,
	}

	formatted, err := EncodeConfigData("PHIQUICKCMDS", exportData)
	if err != nil {
		http.Error(w, "Failed to serialize export data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"config": formatted,
	})
}

// handleConfigExportTerminalCommands exports ONLY the terminal_commands list
// (the cmd panel — commands that spawn new shell tabs). Decoupled from quick
// commands in v0.7.16.
func (app *Server) handleConfigExportTerminalCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cfg := app.loadConfig()
	exportData := struct {
		TerminalCommands []config.QuickCommand `json:"terminal_commands"`
	}{
		TerminalCommands: cfg.TerminalCommands,
	}

	formatted, err := EncodeConfigData("PHITERMCMDS", exportData)
	if err != nil {
		http.Error(w, "Failed to serialize export data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"config": formatted,
	})
}

// handleConfigImportCmds accepts pasted config data from any of the three
// cmd-prefixes: PHIQUICKCMDS, PHITERMCMDS, or the legacy PHICMDS (which
// contained both). Whichever prefix is used, only the matching field(s)
// are imported - so a user can paste a quick-commands config into a
// session that previously only had terminal commands, and vice versa,
// without overwriting the other. Unknown prefixes return 400.
func (app *Server) handleConfigImportCmds(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Config string `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Pick the prefix; supports the legacy combined "PHICMDS:" as a fallback
	// for old exports. The new split prefixes are tried first.
	var jsonData []byte
	var prefix string
	for _, p := range []string{"PHIQUICKCMDS", "PHITERMCMDS", "PHICMDS"} {
		if jd, err := DecodeConfigData(req.Config, p); err == nil {
			jsonData = jd
			prefix = p
			break
		}
	}
	if jsonData == nil {
		http.Error(w, "config.Config is missing or uses an unknown prefix (expected PHIQUICKCMDS, PHITERMCMDS, or PHICMDS)", http.StatusBadRequest)
		return
	}
	_ = prefix // accepted whichever matched; payload below decides what to write

	// The payload may contain either field, or both (legacy). Only overwrite
	// the fields actually present in the JSON.
	var importedData struct {
		QuickCommands    []config.QuickCommand `json:"quick_commands"`
		TerminalCommands []config.QuickCommand `json:"terminal_commands"`
	}
	if err := json.Unmarshal(jsonData, &importedData); err != nil {
		http.Error(w, "Failed to parse configuration JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
	changed := false
	if importedData.QuickCommands != nil {
		cfg.QuickCommands = importedData.QuickCommands
		changed = true
	}
	if importedData.TerminalCommands != nil {
		cfg.TerminalCommands = importedData.TerminalCommands
		changed = true
	}
	if !changed {
		http.Error(w, "config.Config contained no recognized command lists", http.StatusBadRequest)
		return
	}

	app.saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}
