package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

func sendPushoverNotification(userKey, appToken, title, message string) error {
	formData := url.Values{}
	formData.Set("user", userKey)
	formData.Set("token", appToken)
	formData.Set("title", title)
	formData.Set("message", message)
	formData.Set("priority", "1")

	resp, err := http.PostForm("https://api.pushover.net/1/messages.json", formData)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pushover status %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

func handleGetPushoverConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := loadConfig()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"pushover_user_key":  cfg.PushoverUserKey,
		"pushover_app_token": cfg.PushoverAppToken,
		"pushover_enabled":   cfg.PushoverEnabled,
	})
}

func handlePostPushoverConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PushoverUserKey  string `json:"pushover_user_key"`
		PushoverAppToken string `json:"pushover_app_token"`
		PushoverEnabled  bool   `json:"pushover_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	cfg.PushoverUserKey = req.PushoverUserKey
	cfg.PushoverAppToken = req.PushoverAppToken
	cfg.PushoverEnabled = req.PushoverEnabled
	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

func handleTestPushover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := loadConfig()
	if cfg.PushoverUserKey == "" || cfg.PushoverAppToken == "" {
		http.Error(w, "Pushover User Key and App Token are required", http.StatusBadRequest)
		return
	}
	err := sendPushoverNotification(cfg.PushoverUserKey, cfg.PushoverAppToken, "Phi", "Test notification from Phi 🚀")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func sendWebhookNotification(webhookURL, title, message string) error {
	webhookURL = strings.TrimSpace(webhookURL)
	if webhookURL == "" {
		return fmt.Errorf("Webhook URL is empty")
	}

	// Support Bark iOS push (e.g. https://api.day.app/YOUR_KEY/)
	if strings.Contains(webhookURL, "api.day.app") {
		barkURL := strings.TrimRight(webhookURL, "/") + "/" + url.PathEscape(title) + "/" + url.PathEscape(message)
		resp, err := http.Get(barkURL)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("Bark returned status %d: %s", resp.StatusCode, string(b))
		}
		return nil
	}

	// Generic POST JSON webhook
	payload := map[string]string{
		"title":   title,
		"message": message,
		"text":    message,
		"content": message,
	}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", webhookURL, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Webhook returned status %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

func handleGetWebhookConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := loadConfig()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"webhook_url":     cfg.WebhookURL,
		"webhook_enabled": cfg.WebhookEnabled,
	})
}

func handlePostWebhookConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		WebhookURL     string `json:"webhook_url"`
		WebhookEnabled bool   `json:"webhook_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	cfg.WebhookURL = req.WebhookURL
	cfg.WebhookEnabled = req.WebhookEnabled
	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

func handleTestWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := loadConfig()
	if cfg.WebhookURL == "" {
		http.Error(w, "Webhook URL is required", http.StatusBadRequest)
		return
	}
	err := sendWebhookNotification(cfg.WebhookURL, "Phi", "Test notification from Phi 🚀")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func themeEmoji(color string) string {
	switch strings.ToLower(color) {
	case "blue":
		return "🔵"
	case "green":
		return "🟢"
	case "orange":
		return "🟠"
	case "pink", "magenta":
		return "🌸"
	case "cyan":
		return "💎"
	case "red":
		return "🔴"
	case "yellow":
		return "🟡"
	default:
		return "🟣"
	}
}

func sendSimplepushNotification(key, title, message, event string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("Simplepush Key is empty")
	}
	formData := url.Values{}
	formData.Set("key", key)
	formData.Set("title", title)
	formData.Set("msg", message)
	if event != "" {
		formData.Set("event", event)
	}

	resp, err := http.PostForm("https://api.simplepush.io/send", formData)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Simplepush status %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

func handleGetSimplepushConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := loadConfig()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"simplepush_key":     cfg.SimplepushKey,
		"simplepush_enabled": cfg.SimplepushEnabled,
	})
}

func handlePostSimplepushConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		SimplepushKey     string `json:"simplepush_key"`
		SimplepushEnabled bool   `json:"simplepush_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	cfg.SimplepushKey = req.SimplepushKey
	cfg.SimplepushEnabled = req.SimplepushEnabled
	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

func handleTestSimplepush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := loadConfig()
	if cfg.SimplepushKey == "" {
		http.Error(w, "Simplepush Key is required", http.StatusBadRequest)
		return
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "localhost"
	}
	emoji := themeEmoji(cfg.ThemeColor)
	title := fmt.Sprintf("[phi] Test Alert @ %s %s", host, emoji)
	msg := fmt.Sprintf("🚀 Test notification from Phi!\n🎨 Active Theme: %s %s\n💻 Host: %s", cfg.ThemeColor, emoji, host)
	err := sendSimplepushNotification(cfg.SimplepushKey, title, msg, "phi_test")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
}
