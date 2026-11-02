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
	"strings"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// Byte positions alone cannot certify same-position geometry changes.
// Keep this parser independent of the server package and its storage.
type replayPosition struct{ epoch, seq, ordinal uint64 }

func parseReplayPosition(cursor string) (replayPosition, error) {
	var p replayPosition
	parts := strings.Split(cursor, ".")
	if len(cursor) > 128 || len(parts) != 4 || parts[0] != "v1" {
		return p, errInvalidRecording
	}
	values := []*uint64{&p.epoch, &p.seq, &p.ordinal}
	for i, dest := range values {
		n, err := strconv.ParseUint(parts[i+1], 10, 53)
		if err != nil {
			return p, errInvalidRecording
		}
		*dest = n
	}
	return p, nil
}
func (p replayPosition) String() string { return fmt.Sprintf("v1.%d.%d.%d", p.epoch, p.seq, p.ordinal) }

// replay reads one bounded page. A latest request captures a finite target;
// every following page uses that exact byte/event fence, never a moving head.
func (a *apiClient) replay(ctx context.Context, pane string, epoch, from, through uint64, after, fence string, latest bool) (wireproto.ReplayHeader, []byte, error) {
	var h wireproto.ReplayHeader
	if after == "" {
		after = (replayPosition{epoch: epoch, seq: from}).String()
	}
	before, err := parseReplayPosition(after)
	if err != nil || before.epoch != epoch || before.seq != from {
		return h, nil, errInvalidRecording
	}
	q := url.Values{"epoch": {strconv.FormatUint(epoch, 10)}, "from": {strconv.FormatUint(from, 10)}, "after_event_cursor": {after}}
	if latest {
		q.Set("through", "latest")
	} else {
		q.Set("through", strconv.FormatUint(through, 10))
		q.Set("through_event_cursor", fence)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base.String()+"/api/terminals/"+url.PathEscape(pane)+"/replay?"+q.Encode(), nil)
	if err != nil {
		return h, nil, err
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return h, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return h, nil, &apiError{Code: resp.StatusCode, Message: "terminal replay: " + resp.Status}
	}
	const maxBody = 4 + (64 << 10) + recordingPageBytes
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return h, nil, err
	}
	if len(body) < 4 || len(body) > maxBody {
		return h, nil, errInvalidRecording
	}
	n := int(binary.BigEndian.Uint32(body))
	if n > 64<<10 || n+4 > len(body) {
		return h, nil, errInvalidRecording
	}
	if err := json.Unmarshal(body[4:4+n], &h); err != nil {
		return h, nil, fmt.Errorf("%w: %v", errInvalidRecording, err)
	}
	data := body[4+n:]
	end, err := parseReplayPosition(h.EventCursor)
	if err != nil {
		return h, nil, err
	}
	target, err := parseReplayPosition(h.ThroughCursor)
	if err != nil {
		return h, nil, err
	}
	if h.Epoch != epoch || h.Start != from || h.End < from || h.End-from != uint64(len(data)) || len(data) > recordingPageBytes ||
		end.epoch != epoch || end.seq != h.End || end.ordinal < before.ordinal ||
		target.epoch != epoch || target.seq != h.Through || h.End > target.seq || end.ordinal > target.ordinal ||
		(!latest && (h.Through != through || h.ThroughCursor != fence)) ||
		h.InitCols == 0 || h.InitCols > 65535 || h.InitRows == 0 || h.InitRows > 65535 || len(h.Resizes) > 256 ||
		end.ordinal-before.ordinal != uint64(len(h.Resizes)) ||
		(end == before && end != target) {
		return h, nil, errInvalidRecording
	}
	last := from
	for _, resize := range h.Resizes {
		if resize[0] < last || resize[0] > h.End || resize[1] == 0 || resize[1] > 65535 || resize[2] == 0 || resize[2] > 65535 {
			return h, nil, errInvalidRecording
		}
		last = resize[0]
	}
	return h, data, nil
}
