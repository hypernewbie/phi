package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
)

const (
	attachmentMultipartOverhead = 64 << 10
	attachmentFieldMaxBytes     = 1_024
	attachmentPaneMaxBytes      = 256
)

var attachmentPutReadTimeout = 10 * time.Minute

func handleAttachmentsV2Item(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	prefix := "/api/attachments/v2/items/"
	id := strings.TrimPrefix(r.URL.Path, prefix)
	if id == r.URL.Path || strings.Contains(id, "/") || !canonicalAttachmentUUID(id) {
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	switch r.Method {
	case http.MethodGet:
		handleAttachmentItemStatus(w, r, id)
	case http.MethodPut:
		handleAttachmentItemPut(w, r, id)
	default:
		w.Header().Set("Allow", "GET, PUT")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleAttachmentItemStatus(w http.ResponseWriter, r *http.Request, id string) {
	pane := r.URL.Query().Get("pane")
	if pane == "" || len(pane) > attachmentPaneMaxBytes {
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	if attachmentStore == nil {
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(attachmentStore.ItemStatus(id, pane))
}

func handleAttachmentItemPut(w http.ResponseWriter, r *http.Request, id string) {
	if !attachmentSameOrigin(r) {
		writeAttachmentJSONError(w, http.StatusForbidden, "unavailable")
		return
	}
	clearDeadline, ok := setAttachmentReadDeadline(w, r, attachmentPutReadTimeout)
	if !ok {
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	defer clearDeadline()
	if attachmentStore == nil {
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, attachmentUploadMaxBytes+attachmentMultipartOverhead)
	reader, err := r.MultipartReader()
	if err != nil {
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	pane, name := "", ""
	seenPane, seenName := false, false
	for {
		part, partErr := reader.NextPart()
		if errors.Is(partErr, io.EOF) {
			writeAttachmentJSONError(w, http.StatusBadRequest, "missing-item")
			return
		}
		if partErr != nil {
			writeMultipartError(w, partErr)
			return
		}
		field := part.FormName()
		switch field {
		case "pane", "name":
			limit := int64(attachmentPaneMaxBytes)
			if field == "name" {
				limit = attachmentMaxNameBytes
			}
			value, readErr := io.ReadAll(io.LimitReader(part, limit+1))
			_ = part.Close()
			if readErr != nil || int64(len(value)) > limit {
				writeAttachmentJSONError(w, http.StatusRequestEntityTooLarge, "limit")
				return
			}
			if field == "pane" {
				if seenPane {
					writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
					return
				}
				seenPane, pane = true, string(value)
			} else {
				if seenName {
					writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
					return
				}
				seenName, name = true, string(value)
			}
		case "file":
			if !seenPane || !seenName || pane == "" {
				_ = part.Close()
				writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
				return
			}
			if _, err := requireLivePiPane(pane); err != nil {
				_ = part.Close()
				writeAttachmentJSONError(w, http.StatusNotFound, "unavailable")
				return
			}
			finish := func() error {
				extra, extraErr := reader.NextPart()
				if errors.Is(extraErr, io.EOF) {
					return nil
				}
				if extraErr != nil {
					return errAttachmentInvalid
				}
				_ = extra.Close()
				return errAttachmentInvalid
			}
			item, putErr := attachmentStore.Put(r.Context(), id, pane, name, part.Header.Get("Content-Type"), part, finish)
			if putErr != nil {
				writeAttachmentStoreError(w, putErr)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(item)
			return
		default:
			_ = part.Close()
			writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
			return
		}
	}
}

func requireLivePiPane(paneID string) (*pty.PTYInstance, error) {
	if ptyManager == nil || paneID == "" || len(paneID) > attachmentPaneMaxBytes {
		return nil, errAttachmentNotFound
	}
	inst, ok := ptyManager.Get(paneID)
	if !ok || inst == nil || inst.Coder != "pi" || inst.IsPtyDead() {
		return nil, errAttachmentNotFound
	}
	return inst, nil
}

func setAttachmentReadDeadline(w http.ResponseWriter, r *http.Request, timeout time.Duration) (func(), bool) {
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return nil, false
	}
	return func() { _ = controller.SetReadDeadline(time.Time{}) }, true
}

func attachmentSameOrigin(r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
			return false
		}
		if !strings.EqualFold(u.Host, r.Host) || !strings.EqualFold(u.Scheme, "http") && !strings.EqualFold(u.Scheme, "https") {
			return false
		}
		if r.TLS != nil && !strings.EqualFold(u.Scheme, "https") {
			return false
		}
	}
	if site := strings.ToLower(r.Header.Get("Sec-Fetch-Site")); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	return true
}

func writeMultipartError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeAttachmentJSONError(w, http.StatusRequestEntityTooLarge, "limit")
		return
	}
	writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
}

func writeAttachmentStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAttachmentInvalid):
		writeAttachmentJSONError(w, http.StatusBadRequest, "invalid-item")
	case errors.Is(err, errAttachmentChanged):
		writeAttachmentJSONError(w, http.StatusConflict, "changed-source")
	case errors.Is(err, errAttachmentConflict), errors.Is(err, errAttachmentReceiving):
		writeAttachmentJSONError(w, http.StatusConflict, "invalid-item")
	case errors.Is(err, errAttachmentNotFound):
		writeAttachmentJSONError(w, http.StatusNotFound, "missing-item")
	case errors.Is(err, errAttachmentForbidden):
		writeAttachmentJSONError(w, http.StatusForbidden, "unavailable")
	case errors.Is(err, errAttachmentLimit):
		writeAttachmentJSONError(w, http.StatusRequestEntityTooLarge, "limit")
	case errors.Is(err, errAttachmentUnsupported):
		writeAttachmentJSONError(w, http.StatusUnsupportedMediaType, "unsupported-image")
	default:
		writeAttachmentJSONError(w, http.StatusServiceUnavailable, "storage")
	}
}

func writeAttachmentJSONError(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"reason": reason})
}
