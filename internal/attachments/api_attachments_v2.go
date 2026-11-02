package attachments

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
	PaneMaxBytes      = 256
)

var attachmentPutReadTimeout = 10 * time.Minute

func HandleV2Item(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	prefix := "/api/attachments/v2/items/"
	id := strings.TrimPrefix(r.URL.Path, prefix)
	if id == r.URL.Path || strings.Contains(id, "/") || !CanonicalUUID(id) {
		WriteJSONError(w, http.StatusBadRequest, "invalid-item")
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
	if pane == "" || len(pane) > PaneMaxBytes {
		WriteJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	if Default == nil {
		WriteJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(Default.ItemStatus(id, pane))
}

func handleAttachmentItemPut(w http.ResponseWriter, r *http.Request, id string) {
	if !SameOrigin(r) {
		WriteJSONError(w, http.StatusForbidden, "unavailable")
		return
	}
	clearDeadline, ok := SetReadDeadline(w, r, attachmentPutReadTimeout)
	if !ok {
		WriteJSONError(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	defer clearDeadline()
	if Default == nil {
		WriteJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		WriteJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, attachmentUploadMaxBytes+attachmentMultipartOverhead)
	reader, err := r.MultipartReader()
	if err != nil {
		WriteJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	pane, name := "", ""
	seenPane, seenName := false, false
	for {
		part, partErr := reader.NextPart()
		if errors.Is(partErr, io.EOF) {
			WriteJSONError(w, http.StatusBadRequest, "missing-item")
			return
		}
		if partErr != nil {
			writeMultipartError(w, partErr)
			return
		}
		field := part.FormName()
		switch field {
		case "pane", "name":
			limit := int64(PaneMaxBytes)
			if field == "name" {
				limit = attachmentMaxNameBytes
			}
			value, readErr := io.ReadAll(io.LimitReader(part, limit+1))
			_ = part.Close()
			if readErr != nil || int64(len(value)) > limit {
				WriteJSONError(w, http.StatusRequestEntityTooLarge, "limit")
				return
			}
			if field == "pane" {
				if seenPane {
					WriteJSONError(w, http.StatusBadRequest, "invalid-item")
					return
				}
				seenPane, pane = true, string(value)
			} else {
				if seenName {
					WriteJSONError(w, http.StatusBadRequest, "invalid-item")
					return
				}
				seenName, name = true, string(value)
			}
		case "file":
			if !seenPane || !seenName || pane == "" {
				_ = part.Close()
				WriteJSONError(w, http.StatusBadRequest, "invalid-item")
				return
			}
			if _, err := LivePiPane(pane); err != nil {
				_ = part.Close()
				WriteJSONError(w, http.StatusNotFound, "unavailable")
				return
			}
			finish := func() error {
				extra, extraErr := reader.NextPart()
				if errors.Is(extraErr, io.EOF) {
					return nil
				}
				if extraErr != nil {
					return ErrInvalid
				}
				_ = extra.Close()
				return ErrInvalid
			}
			item, putErr := Default.Put(r.Context(), id, pane, name, part.Header.Get("Content-Type"), part, finish)
			if putErr != nil {
				WriteStoreError(w, putErr)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(item)
			return
		default:
			_ = part.Close()
			WriteJSONError(w, http.StatusBadRequest, "invalid-item")
			return
		}
	}
}

// LivePiPane returns the live PTY instance for a pane ID.
func LivePiPane(paneID string) (*pty.PTYInstance, error) {
	if paneManager() == nil || paneID == "" || len(paneID) > PaneMaxBytes {
		return nil, ErrNotFound
	}
	inst, ok := paneManager().Get(paneID)
	if !ok || inst == nil || inst.Coder != "pi" || inst.IsPtyDead() {
		return nil, ErrNotFound
	}
	return inst, nil
}

// SetReadDeadline bounds how long a client may take to send a body.
func SetReadDeadline(w http.ResponseWriter, r *http.Request, timeout time.Duration) (func(), bool) {
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return nil, false
	}
	return func() { _ = controller.SetReadDeadline(time.Time{}) }, true
}

// SameOrigin reports whether the request passes the attachment CSRF check.
func SameOrigin(r *http.Request) bool {
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
		WriteJSONError(w, http.StatusRequestEntityTooLarge, "limit")
		return
	}
	WriteJSONError(w, http.StatusBadRequest, "invalid-item")
}

func WriteStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalid):
		WriteJSONError(w, http.StatusBadRequest, "invalid-item")
	case errors.Is(err, errAttachmentChanged):
		WriteJSONError(w, http.StatusConflict, "changed-source")
	case errors.Is(err, errAttachmentConflict), errors.Is(err, errAttachmentReceiving):
		WriteJSONError(w, http.StatusConflict, "invalid-item")
	case errors.Is(err, ErrNotFound):
		WriteJSONError(w, http.StatusNotFound, "missing-item")
	case errors.Is(err, errAttachmentForbidden):
		WriteJSONError(w, http.StatusForbidden, "unavailable")
	case errors.Is(err, ErrLimit):
		WriteJSONError(w, http.StatusRequestEntityTooLarge, "limit")
	case errors.Is(err, ErrUnsupported):
		WriteJSONError(w, http.StatusUnsupportedMediaType, "unsupported-image")
	default:
		WriteJSONError(w, http.StatusServiceUnavailable, "storage")
	}
}

func WriteJSONError(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"reason": reason})
}

// writeAttachmentBodyError maps a JSON body decode failure to the route's
// error contract: oversize bodies report the limit, everything else is an
// invalid item.
// WriteJSONBodyError maps a JSON body decode failure to the route contract.
func WriteJSONBodyError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		WriteJSONError(w, http.StatusRequestEntityTooLarge, "limit")
		return
	}
	WriteJSONError(w, http.StatusBadRequest, "invalid-item")
}
