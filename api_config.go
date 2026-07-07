package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

func handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()
	hName, _ := os.Hostname()
	hName = strings.ToUpper(hName)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"workspaces":                cfg.Workspaces,
		"active_cwd":                activeCWD,
		"theme_color":               cfg.ThemeColor,
		"hostname":                  hName,
		"model_presets":             cfg.ModelPresets,
		"quick_commands":            cfg.QuickCommands,
		"terminal_commands":         cfg.TerminalCommands,
		"markdown_dirs":             cfg.MarkdownDirs,
		"use_existing_terminal_tab": cfg.UseExistingTerminalTab,
		"sync_coordinator":          cfg.SyncCoordinator,
	})
}

func handleWorkspaceToggle(w http.ResponseWriter, r *http.Request) {
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

	cfg := loadConfig()

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
			saveConfig(cfg)
		}
	} else if r.Method == http.MethodDelete {
		newWS := []string{}
		for _, wsPath := range cfg.Workspaces {
			if wsPath != path {
				newWS = append(newWS, wsPath)
			}
		}
		cfg.Workspaces = newWS
		saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func handleModelPresets(w http.ResponseWriter, r *http.Request) {
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

	cfg := loadConfig()

	if r.Method == http.MethodPost {
		if cfg.ModelPresets == nil {
			cfg.ModelPresets = make(ModelPresetsMap)
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
		saveConfig(cfg)
	} else if r.Method == http.MethodDelete {
		if cfg.ModelPresets != nil {
			newPresets := []string{}
			for _, m := range cfg.ModelPresets[coder] {
				if m != model {
					newPresets = append(newPresets, m)
				}
			}
			cfg.ModelPresets[coder] = newPresets
			saveConfig(cfg)
		}
	}

	w.WriteHeader(http.StatusOK)
}

func handleQuickCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()

	if r.Method == http.MethodPost {
		// Try parsing as slice/array first for bulk overwrite
		var listReq []QuickCommand
		if err := json.Unmarshal(bodyBytes, &listReq); err == nil {
			cfg.QuickCommands = listReq
			saveConfig(cfg)
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
				cfg.QuickCommands[i] = QuickCommand{Name: singleReq.Name, Command: singleReq.Command}
				found = true
				break
			}
		}
		if !found {
			cfg.QuickCommands = append(cfg.QuickCommands, QuickCommand{Name: singleReq.Name, Command: singleReq.Command})
		}
		saveConfig(cfg)
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

		newCmds := []QuickCommand{}
		for _, qc := range cfg.QuickCommands {
			if qc.Name != singleReq.Name {
				newCmds = append(newCmds, qc)
			}
		}
		cfg.QuickCommands = newCmds
		saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func handleTerminalCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()

	if r.Method == http.MethodPost {
		// Try parsing as slice/array first for bulk overwrite
		var listReq []QuickCommand
		if err := json.Unmarshal(bodyBytes, &listReq); err == nil {
			cfg.TerminalCommands = listReq
			saveConfig(cfg)
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
				cfg.TerminalCommands[i] = QuickCommand{Name: singleReq.Name, Command: singleReq.Command}
				found = true
				break
			}
		}
		if !found {
			cfg.TerminalCommands = append(cfg.TerminalCommands, QuickCommand{Name: singleReq.Name, Command: singleReq.Command})
		}
		saveConfig(cfg)
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

		newCmds := []QuickCommand{}
		for _, tc := range cfg.TerminalCommands {
			if tc.Name != singleReq.Name {
				newCmds = append(newCmds, tc)
			}
		}
		cfg.TerminalCommands = newCmds
		saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func handleThemeUpdate(w http.ResponseWriter, r *http.Request) {
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

	cfg := loadConfig()
	cfg.ThemeColor = color
	saveConfig(cfg)

	w.WriteHeader(http.StatusOK)
}

func handleUseExistingTerminalTab(w http.ResponseWriter, r *http.Request) {
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

	cfg := loadConfig()
	cfg.UseExistingTerminalTab = req.Enabled
	saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.UseExistingTerminalTab})
}

// encodeConfigData serializes, base64-encodes, hashes, and formats with a prefix.
func encodeConfigData(prefix string, data interface{}) (string, error) {
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
func decodeConfigData(raw string, expectedPrefix string) ([]byte, error) {
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

func handleConfigExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cfg := loadConfig()
	exportData := struct {
		ModelPresets     ModelPresetsMap `json:"model_presets"`
		QuickCommands    []QuickCommand  `json:"quick_commands"`
		TerminalCommands []QuickCommand  `json:"terminal_commands"`
	}{
		ModelPresets:     cfg.ModelPresets,
		QuickCommands:    cfg.QuickCommands,
		TerminalCommands: cfg.TerminalCommands,
	}

	formatted, err := encodeConfigData("PHICONFIG", exportData)
	if err != nil {
		http.Error(w, "Failed to serialize export data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"config": formatted,
	})
}

func handleConfigImport(w http.ResponseWriter, r *http.Request) {
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

	jsonData, err := decodeConfigData(req.Config, "PHICONFIG")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var importedData struct {
		ModelPresets     ModelPresetsMap `json:"model_presets"`
		QuickCommands    []QuickCommand  `json:"quick_commands"`
		TerminalCommands []QuickCommand  `json:"terminal_commands"`
	}

	if err := json.Unmarshal(jsonData, &importedData); err != nil {
		http.Error(w, "Failed to parse configuration JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	if importedData.ModelPresets != nil {
		cfg.ModelPresets = importedData.ModelPresets
	}
	if len(importedData.QuickCommands) > 0 {
		cfg.QuickCommands = importedData.QuickCommands
	}
	if len(importedData.TerminalCommands) > 0 {
		cfg.TerminalCommands = importedData.TerminalCommands
	}

	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

func handleConfigExportModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cfg := loadConfig()
	exportData := struct {
		ModelPresets ModelPresetsMap `json:"model_presets"`
	}{
		ModelPresets: cfg.ModelPresets,
	}

	formatted, err := encodeConfigData("PHIMODELS", exportData)
	if err != nil {
		http.Error(w, "Failed to serialize export data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"config": formatted,
	})
}

func handleConfigImportModels(w http.ResponseWriter, r *http.Request) {
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

	jsonData, err := decodeConfigData(req.Config, "PHIMODELS")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var importedData struct {
		ModelPresets ModelPresetsMap `json:"model_presets"`
	}

	if err := json.Unmarshal(jsonData, &importedData); err != nil {
		http.Error(w, "Failed to parse configuration JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	if importedData.ModelPresets != nil {
		cfg.ModelPresets = importedData.ModelPresets
	}

	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

func handleConfigExportCmds(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cfg := loadConfig()
	exportData := struct {
		QuickCommands    []QuickCommand `json:"quick_commands"`
		TerminalCommands []QuickCommand `json:"terminal_commands"`
	}{
		QuickCommands:    cfg.QuickCommands,
		TerminalCommands: cfg.TerminalCommands,
	}

	formatted, err := encodeConfigData("PHICMDS", exportData)
	if err != nil {
		http.Error(w, "Failed to serialize export data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"config": formatted,
	})
}

func handleConfigImportCmds(w http.ResponseWriter, r *http.Request) {
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

	jsonData, err := decodeConfigData(req.Config, "PHICMDS")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var importedData struct {
		QuickCommands    []QuickCommand `json:"quick_commands"`
		TerminalCommands []QuickCommand `json:"terminal_commands"`
	}

	if err := json.Unmarshal(jsonData, &importedData); err != nil {
		http.Error(w, "Failed to parse configuration JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	if importedData.QuickCommands != nil {
		cfg.QuickCommands = importedData.QuickCommands
	}
	if importedData.TerminalCommands != nil {
		cfg.TerminalCommands = importedData.TerminalCommands
	}

	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}
