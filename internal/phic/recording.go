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

// errRecordingExpired marks a prefix the server evicted. Unlike a malformed
// response it authorizes recovery through an authoritative checkpoint.
var errRecordingExpired = errors.New("recording prefix expired")

// isRecordingExpired reports the failures a live checkpoint can heal: an
// evicted prefix (advanced start) or a wholly expired span (400).
func isRecordingExpired(err error) bool {
	if errors.Is(err, errRecordingExpired) {
		return true
	}
	var status *apiError
	return errors.As(err, &status) && status.Code == http.StatusBadRequest
}

func (a *apiClient) recording(ctx context.Context, pane string, epoch, from, through uint64, after string) (wireproto.RecordingHeader, []byte, error) {
	var h wireproto.RecordingHeader
	if through < from || through-from > recordingPageBytes {
		return h, nil, errInvalidRecording
	}
	q := url.Values{"from": {strconv.FormatUint(from, 10)}, "through": {strconv.FormatUint(through, 10)}, "epoch": {strconv.FormatUint(epoch, 10)}}
	if after != "" {
		q.Set("after_event_cursor", after)
	}
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
	if h.Start > from {
		return h, nil, errRecordingExpired
	}
	if h.Epoch != epoch || h.Start != from || h.End < h.Start || h.End > through || h.End-h.Start != uint64(len(data)) || len(h.EventCursor) > 128 {
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
		h, data, err := r.api.recording(ctx, pane, r.epoch, from, through, "")
		if err == nil || permanent(err) || errors.Is(err, errInvalidRecording) || errors.Is(err, errRecordingExpired) {
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
	return r.recoverOutput(ctx, pane, head, false)
}

// checkpointJump adopts the authoritative live screen when the recorded
// prefix is gone. The synthetic bytes repaint the display; the source
// frontier jumps to the checkpoint instead of advancing through them, and
// remembered frontiers keep meaning "display reflects this source point".
func (r *Relay) checkpointJump(ctx context.Context, pane string) error {
	var header wireproto.AttachHeadHeader
	var data []byte
	for {
		var err error
		header, data, err = r.api.ansiState(ctx, pane, r.epoch)
		if err == nil || permanent(err) || errors.Is(err, errInvalidRecording) {
			if err != nil {
				return err
			}
			break
		}
		var n net.Error
		var status *apiError
		if !errors.As(err, &n) && !errors.As(err, &status) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	if header.Head <= r.written {
		return errors.New("phic: checkpoint frontier did not advance")
	}
	// The held prefix is expired; the checkpoint supersedes it.
	r.repaint = &repaintFilter{}
	if err := r.write(ctx, data); err != nil {
		return err
	}
	r.written = header.Head
	return nil
}

// ansiState fetches the current screen with continuation for a native
// terminal that lost its recorded prefix. Old servers answer without a
// cursor; missing groups fail instead of synthesizing bytes.
func (a *apiClient) ansiState(ctx context.Context, pane string, epoch uint64) (wireproto.AttachHeadHeader, []byte, error) {
	var header wireproto.AttachHeadHeader
	query := url.Values{"epoch": {strconv.FormatUint(epoch, 10)}, "through": {"latest"}, "kind": {"ansi-v1"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base.String()+"/api/terminals/"+url.PathEscape(pane)+"/state?"+query.Encode(), nil)
	if err != nil {
		return header, nil, err
	}
	response, err := a.http.Do(req)
	if err != nil {
		return header, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return header, nil, &apiError{Code: response.StatusCode, Message: response.Status}
	}
	bytes, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+4097))
	if err != nil {
		return header, nil, err
	}
	if len(bytes) < 4 || len(bytes) > (2<<20)+4096 {
		return header, nil, errInvalidRecording
	}
	length := int(binary.BigEndian.Uint32(bytes))
	if length > 4096 || length+4 > len(bytes) {
		return header, nil, errInvalidRecording
	}
	if err = json.Unmarshal(bytes[4:4+length], &header); err != nil {
		return header, nil, err
	}
	data := bytes[4+length:]
	if header.Epoch != epoch || header.Ckpt == nil || header.Ckpt.Kind != "ansi-v1" || header.Ckpt.Through != header.Head || header.Ckpt.Len != len(data) || header.Ckpt.Cols == 0 || header.Ckpt.Rows == 0 || len(header.Ckpt.EventCursor) > 128 {
		return header, nil, errInvalidRecording
	}
	return header, data, nil
}

func (r *Relay) recoverOutput(ctx context.Context, pane string, head uint64, historical bool) error {
	for r.written < head {
		end := pageEnd(r.written, head)
		_, data, err := r.fetch(ctx, pane, r.written, end)
		if err != nil {
			if isRecordingExpired(err) {
				if jerr := r.checkpointJump(ctx, pane); jerr != nil {
					return jerr
				}
				continue
			}
			return err
		}
		if uint64(len(data)) != end-r.written {
			return fmt.Errorf("%w: unavailable interval", errInvalidRecording)
		}
		if err := r.output(ctx, data, historical); err != nil {
			return err
		}
	}
	return nil
}

// output advances a SOURCE frontier. Repaint-only controls may be omitted or
// held in the bounded lexer, but the source recording is never changed. A new
// live control is written verbatim. Failed writes stop attachment; they cannot
// authorize skipping a later source span.
func (r *Relay) output(ctx context.Context, data []byte, historical bool) error {
	if r.repaint == nil {
		return r.write(ctx, data)
	}
	paint, err := r.repaint.Feed(data, historical)
	if err != nil {
		return err
	}
	before := r.written
	err = r.write(ctx, paint)
	// Display bytes have no one-to-one source offset after query suppression.
	// Only a completed batch can certify its source interval.
	r.written = before
	if err == nil {
		r.written += uint64(len(data))
	}
	return err
}
func (r *Relay) drainExit(ctx context.Context, pane string) error {
	for {
		if r.written > ^uint64(0)-recordingPageBytes {
			return errInvalidRecording
		}
		_, data, err := r.fetch(ctx, pane, r.written, r.written+recordingPageBytes)
		if err != nil {
			if isRecordingExpired(err) {
				if jerr := r.checkpointJump(ctx, pane); jerr != nil {
					return jerr
				}
				continue
			}
			return err
		}
		if err := r.output(ctx, data, false); err != nil {
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
