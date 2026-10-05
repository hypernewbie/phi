package phic

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

const recordingPageBytes = 2 << 20

var errInvalidRecording = errors.New("invalid recording")

func (a *apiClient) recording(ctx context.Context, pane string, epoch, from, through uint64) (wireproto.RecordingHeader, []byte, error) {
	var h wireproto.RecordingHeader
	if through < from || through-from > recordingPageBytes {
		return h, nil, errInvalidRecording
	}
	q := url.Values{"from": {strconv.FormatUint(from, 10)}, "through": {strconv.FormatUint(through, 10)}, "epoch": {strconv.FormatUint(epoch, 10)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base.String()+"/api/terminals/"+url.PathEscape(pane)+"/recording?"+q.Encode(), nil)
	if err != nil {
		return h, nil, err
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return h, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return h, nil, &apiError{Code: resp.StatusCode, Message: "recording: " + resp.Status}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4+2*recordingPageBytes+1))
	if err != nil {
		return h, nil, err
	}
	if len(body) < 4 || len(body) > 4+2*recordingPageBytes {
		return h, nil, errInvalidRecording
	}
	n := uint64(binary.BigEndian.Uint32(body[:4]))
	if n > recordingPageBytes || n+4 > uint64(len(body)) {
		return h, nil, errInvalidRecording
	}
	if err := json.Unmarshal(body[4:4+n], &h); err != nil {
		return h, nil, fmt.Errorf("%w: %v", errInvalidRecording, err)
	}
	data := body[4+n:]
	if h.Epoch != epoch || h.Start != from || h.End < h.Start || h.End > through || h.End-h.Start != uint64(len(data)) {
		return h, nil, errInvalidRecording
	}
	var last uint64
	for i, size := range h.Resizes {
		if size[0] > h.End || (i > 0 && size[0] < last) || size[1] == 0 || size[1] > 65535 || size[2] == 0 || size[2] > 65535 {
			return h, nil, errInvalidRecording
		}
		last = size[0]
	}
	return h, data, nil
}

func (r *Relay) fetch(ctx context.Context, pane string, from, through uint64) (wireproto.RecordingHeader, []byte, error) {
	for {
		h, data, err := r.api.recording(ctx, pane, r.epoch, from, through)
		if err == nil || permanent(err) || errors.Is(err, errInvalidRecording) {
			return h, data, err
		}
		var n net.Error
		var status *apiError
		if !errors.As(err, &n) && !errors.As(err, &status) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return h, nil, err
		}
		select {
		case <-ctx.Done():
			return h, nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}
func pageEnd(from, head uint64) uint64 {
	if head-from > recordingPageBytes {
		return from + recordingPageBytes
	}
	return head
}
func (r *Relay) recover(ctx context.Context, pane string, head uint64) error {
	for r.written < head {
		end := pageEnd(r.written, head)
		_, data, err := r.fetch(ctx, pane, r.written, end)
		if err != nil {
			return err
		}
		if uint64(len(data)) != end-r.written {
			return fmt.Errorf("%w: unavailable interval", errInvalidRecording)
		}
		if err := r.write(ctx, data); err != nil {
			return err
		}
	}
	return nil
}

func (r *Relay) preflight(ctx context.Context, pane string, head uint64, cols, rows int) error {
	guard := queryGuard{}
	for at := uint64(0); at < head; {
		end := pageEnd(at, head)
		hdr, data, err := r.fetch(ctx, pane, at, end)
		if err != nil {
			return err
		}
		if uint64(len(data)) != end-at {
			return errInvalidRecording
		}
		for _, m := range hdr.Resizes {
			if m[0] < head && (m[1] != uint64(cols) || m[2] != uint64(rows)) {
				return errors.New("phic: historical terminal geometry differs; native replay cannot restore this pane safely")
			}
		}
		if !r.fresh && guard.Feed(data) {
			return errors.New("phic: history contains terminal queries; use a fresh pane rather than inject historical replies into the application")
		}
		at = end
	}
	return nil
}
func (r *Relay) drainExit(ctx context.Context, pane string) error {
	for {
		if r.written > ^uint64(0)-recordingPageBytes {
			return errInvalidRecording
		}
		_, data, err := r.fetch(ctx, pane, r.written, r.written+recordingPageBytes)
		if err != nil {
			return err
		}
		if err := r.write(ctx, data); err != nil {
			return err
		}
		if len(data) < recordingPageBytes {
			return nil
		}
	}
}
func (r *Relay) control(ctx context.Context, pane string, data []byte) error {
	var v struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return fmt.Errorf("phic: invalid control message: %w", err)
	}
	if v.Type == "output-dropped" {
		return r.drainExit(ctx, pane)
	}
	return nil
}
