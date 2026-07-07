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
		_ = json.NewEncoder(w).Encode(map[string]string{"password": pw})

	case http.MethodPost:
		var req struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		enc, err := EncryptVault(req.Password)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		cfg := loadConfig()
		cfg.KanbanPasswordEnc = enc
		saveConfig(cfg)
		w.WriteHeader(http.StatusOK)

	case http.MethodDelete:
		cfg := loadConfig()
		cfg.KanbanPasswordEnc = ""
		saveConfig(cfg)
		w.WriteHeader(http.StatusOK)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
