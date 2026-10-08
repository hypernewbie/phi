package phic

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// A page stays within the client row budget even for one-byte newline output.
const historyByteStep = 4 << 10

type historyResult struct {
	epoch, through, gen uint64
	header              wireproto.AttachHeadHeader
	data                []byte
	record              wireproto.RecordingHeader
	tail                []byte
	err                 error
}

func (a *apiClient) terminalState(ctx context.Context, pane string, epoch, through uint64) (wireproto.AttachHeadHeader, []byte, error) {
	var header wireproto.AttachHeadHeader
	query := url.Values{"epoch": {strconv.FormatUint(epoch, 10)}, "through": {strconv.FormatUint(through, 10)}}
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
	if header.Epoch != epoch || header.Head != through || header.Ckpt == nil || header.Ckpt.Through != through || header.Ckpt.Kind != "ghostty-ready-v1" || header.Ckpt.Len != len(data) || header.Ckpt.Cols == 0 || header.Ckpt.Rows == 0 {
		return header, nil, errInvalidRecording
	}
	return header, data, nil
}

func (p *paneActor) requestHistory() {
	if p.historyPending || p.api == nil {
		return
	}
	p.mu.Lock()
	epoch, frontier := p.epoch, p.frontier
	p.mu.Unlock()
	end := frontier
	if p.history != nil {
		end = p.historyThrough
	}
	if end == 0 {
		return
	}
	from := uint64(0)
	if end > historyByteStep {
		from = end - historyByteStep
	}
	p.historyGen++
	gen := p.historyGen
	p.historyPending = true
	ctx, cancel := context.WithCancel(p.ctx)
	p.historyCancel = cancel
	go func() {
		defer cancel()
		header, data, err := p.api.terminalState(ctx, p.spec.Key.ID, epoch, from)
		var record wireproto.RecordingHeader
		var tail []byte
		if err == nil {
			record, tail, err = p.api.recording(ctx, p.spec.Key.ID, epoch, from, end)
		}
		select {
		case p.histories <- historyResult{epoch: epoch, through: from, gen: gen, header: header, data: data, record: record, tail: tail, err: err}:
		case <-ctx.Done():
		}
	}()
}
func (p *paneActor) applyHistory(result historyResult) error {
	if result.gen != p.historyGen || result.epoch != p.epochValue() {
		return nil
	}
	p.historyPending = false
	if p.historyCancel != nil {
		p.historyCancel()
		p.historyCancel = nil
	}
	if result.err != nil {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: "history: " + result.err.Error()})
		return nil
	}
	build := p.build
	if build == nil {
		build = termemu.NewGhostty
	}
	historical, err := build(termemu.Options{Cols: int(result.header.Ckpt.Cols), Rows: int(result.header.Ckpt.Rows), ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
	if err != nil {
		return err
	}
	restorer, ok := historical.(interface{ RestoreReady([]byte) error })
	if !ok {
		_ = historical.Close()
		return fmt.Errorf("archive state restore unavailable")
	}
	if err = restorer.RestoreReady(result.data); err != nil {
		_ = historical.Close()
		return err
	}
	at := result.record.Start
	for _, resize := range result.record.Resizes {
		offset := max(at, resize[0])
		if offset > at {
			if err = historical.Feed(result.tail[at-result.record.Start:offset-result.record.Start], termemu.SourceReplay); err != nil {
				_ = historical.Close()
				return err
			}
			at = offset
		}
		if err = historical.Resize(int(resize[1]), int(resize[2])); err != nil {
			_ = historical.Close()
			return err
		}
	}
	if err = historical.Feed(result.tail[at-result.record.Start:], termemu.SourceReplay); err != nil {
		_ = historical.Close()
		return err
	}
	frame, err := historical.Snapshot()
	if err != nil {
		_ = historical.Close()
		return err
	}
	if scroller, ok := historical.(interface{ ScrollViewport(int) error }); ok {
		if err = scroller.ScrollViewport(-1 << 30); err != nil {
			_ = historical.Close()
			return err
		}
	}
	if p.history != nil {
		_ = p.history.Close()
	}
	p.history = historical
	p.historyThrough = result.through
	p.historyOffset = -frame.History
	p.dirty = true
	return nil
}
func (p *paneActor) returnLive() {
	p.historyGen++
	p.historyPending = false
	if p.historyCancel != nil {
		p.historyCancel()
		p.historyCancel = nil
	}
	if p.history != nil {
		_ = p.history.Close()
		p.history = nil
		p.dirty = true
	}
	if p.historyOffset != 0 {
		if scroller, ok := p.emu.(interface{ ScrollViewport(int) error }); ok {
			if err := scroller.ScrollViewport(1 << 30); err != nil {
				p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: err.Error()})
			}
		}
		p.dirty = true
	}
	p.historyOffset = 0
}
