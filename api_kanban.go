package main

import (
	"encoding/json"
	"net/http"
)

func handleKanbanVault(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := loadConfig()
		pw, err := DecryptVault(cfg.KanbanPasswordEnc)
		if err != nil {
			http.Error(w, "Failed to decrypt password: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"password": pw,
			"username": cfg.KanbanUsername,
			"url":      cfg.KanbanURL,
		})

	case http.MethodPost:
		var req struct {
			Password string `json:"password"`
			Username string `json:"username"`
			URL      string `json:"url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		cfg := loadConfig()
		if req.Password != "" {
			enc, err := EncryptVault(req.Password)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			cfg.KanbanPasswordEnc = enc
		}
		if req.Username != "" {
			cfg.KanbanUsername = req.Username
		}
		if req.URL != "" {
			cfg.KanbanURL = req.URL
		}
		saveConfig(cfg)
		w.WriteHeader(http.StatusOK)

	case http.MethodDelete:
		cfg := loadConfig()
		cfg.KanbanPasswordEnc = ""
		cfg.KanbanUsername = ""
		cfg.KanbanURL = ""
		saveConfig(cfg)
		w.WriteHeader(http.StatusOK)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
