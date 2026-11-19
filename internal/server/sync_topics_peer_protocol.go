package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/pibridge"
)

const (
	syncTopicsPeerVersion   = 1
	syncTopicsPeerProtocol  = "phi.syncboard.topics.v1"
	syncTopicsPeerMaxID     = 128
	syncTopicsPeerMaxTopic  = 256
	syncTopicsPeerMaxValue  = 88 * 1024
	syncTopicsPeerMaxFrame  = 256 * 1024
	maxSyncTopicPeerIntents = 1024
	maxSyncTopicPeerBatches = 1024
)

type syncTopicPeerFrame struct {
	Type     string            `json:"type"`
	Version  int               `json:"version,omitempty"`
	Peer     string            `json:"peer,omitempty"`
	Instance string            `json:"instance,omitempty"`
	Epoch    string            `json:"epoch,omitempty"`
	Fence    string            `json:"fence,omitempty"`
	Prior    string            `json:"prior_fence,omitempty"`
	Stream   string            `json:"stream,omitempty"`
	State    string            `json:"state,omitempty"`
	Retired  bool              `json:"bindings_retired,omitempty"`
	Control  string            `json:"control,omitempty"`
	Last     string            `json:"last_control,omitempty"`
	Action   string            `json:"action,omitempty"`
	Result   string            `json:"result,omitempty"`
	Reason   string            `json:"reason,omitempty"`
	Owner    *syncTopicWireOwn `json:"owner,omitempty"`
	Topic    string            `json:"topic,omitempty"`
	BatchID  string            `json:"batch_id,omitempty"`
	Seq      string            `json:"seq,omitempty"`
	Value    string            `json:"value,omitempty"`
}

type syncTopicWireOwn struct {
	Pane       string `json:"pane"`
	Process    string `json:"process"`
	Generation uint64 `json:"generation"`
	RuntimeID  string `json:"runtime_id"`
	SessionID  string `json:"session_id"`
}

func randomPeerToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand unavailable")
	}
	return hex.EncodeToString(b[:])
}

func validPeerID(value string) bool {
	return value != "" && len(value) <= syncTopicsPeerMaxID && utf8.ValidString(value) &&
		!strings.ContainsRune(value, 0)
}

func validPeerState(value string) bool {
	return value == "online" || value == "offline" || value == "terminal"
}

func parsePeerCounter(value string, allowZero bool) (uint64, bool) {
	if value == "" || (value == "0" && !allowZero) || len(value) > 20 {
		return 0, false
	}
	if value[0] == '+' || (len(value) > 1 && value[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func validPeerAction(action string) bool {
	return action == "register" || action == "retire_owner" || action == "retire_cohort"
}

func validPeerOwner(owner *syncTopicWireOwn) bool {
	if owner == nil || owner.Pane == "" || owner.Process == "" ||
		len(owner.Pane) > syncTopicsPeerMaxID || len(owner.Process) > syncTopicsPeerMaxID ||
		len(owner.RuntimeID) > syncTopicsPeerMaxID || len(owner.SessionID) > syncTopicsPeerMaxID ||
		!utf8.ValidString(owner.Pane) || !utf8.ValidString(owner.Process) ||
		!utf8.ValidString(owner.RuntimeID) || !utf8.ValidString(owner.SessionID) {
		return false
	}
	return owner.Generation > 0
}

func wireOwnerFromPibridge(owner pibridge.SyncboardOwner) *syncTopicWireOwn {
	return &syncTopicWireOwn{
		Pane: owner.PaneID, Process: owner.ProcessID, Generation: owner.Generation,
		RuntimeID: owner.RuntimeID, SessionID: owner.SessionID,
	}
}

func validPeerControl(frame *syncTopicPeerFrame) bool {
	if !validPeerAction(frame.Action) {
		return false
	}
	switch frame.Action {
	case "register":
		return validPeerOwner(frame.Owner) && frame.Topic != "" &&
			len(frame.Topic) <= syncTopicsPeerMaxTopic && utf8.ValidString(frame.Topic)
	case "retire_owner":
		return validPeerOwner(frame.Owner) && frame.Topic == ""
	case "retire_cohort":
		seq, ok := parsePeerCounter(frame.Control, false)
		return ok && seq == math.MaxUint64 && frame.Topic == ""
	default:
		return false
	}
}

func peerControlFingerprint(frame *syncTopicPeerFrame) string {
	data, _ := json.Marshal(struct {
		Action string            `json:"action"`
		Owner  *syncTopicWireOwn `json:"owner"`
		Topic  string            `json:"topic"`
	}{frame.Action, frame.Owner, frame.Topic})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func validatePeerIdentity(epoch, fence, stream string, requireStream bool) error {
	for _, value := range []string{epoch, fence} {
		if value == "" || len(value) > syncTopicsPeerMaxID || !utf8.ValidString(value) {
			return errors.New("invalid peer identity")
		}
	}
	if requireStream && (stream == "" || len(stream) > syncTopicsPeerMaxID) {
		return errors.New("invalid peer stream")
	}
	if !requireStream && stream != "" {
		return errors.New("unexpected peer stream")
	}
	return nil
}

func validatePeerFrameSize(data []byte) error {
	if len(data) == 0 || len(data) > syncTopicsPeerMaxFrame || !json.Valid(data) || !utf8.Valid(data) {
		return errors.New("invalid peer frame")
	}
	return nil
}

func readPeerFrame(ws *websocket.Conn) (*syncTopicPeerFrame, error) {
	messageType, data, err := ws.ReadMessage()
	if err != nil {
		return nil, err
	}
	if messageType != websocket.TextMessage {
		return nil, errors.New("peer frame is not text")
	}
	if err := validatePeerFrameSize(data); err != nil {
		return nil, err
	}
	var frame syncTopicPeerFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return nil, err
	}
	return &frame, nil
}

func canonicalCounter(value uint64) string {
	return strconv.FormatUint(value, 10)
}

func peerRefusalReason(err error) string {
	switch {
	case errors.Is(err, errSyncTopicCapacity):
		return "capacity"
	case errors.Is(err, errSyncTopicInvalid):
		return "invalid"
	case errors.Is(err, errSyncTopicTooLarge):
		return "too_large"
	default:
		return "unavailable"
	}
}

func validPeerTopic(topic string) bool {
	return topic != "" && len(topic) <= syncTopicsPeerMaxTopic && utf8.ValidString(topic) &&
		!strings.ContainsRune(topic, 0)
}
