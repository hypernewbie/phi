package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

var queueAcceptanceTimeout = 30 * time.Second

// QueueState is Phi's process-local delivery state for one queue item.
type QueueState string

const (
	QueueLocal     QueueState = "local"
	QueueSending   QueueState = "sending"
	QueueAccepted  QueueState = "accepted"
	QueueUncertain QueueState = "uncertain"
	QueueConsumed  QueueState = "consumed"
	QueueCancelled QueueState = "cancelled"
	QueuePromoted  QueueState = "promoted"

	QueueStateLocal     = QueueLocal
	QueueStateSending   = QueueSending
	QueueStateAccepted  = QueueAccepted
	QueueStateUncertain = QueueUncertain
	QueueStateConsumed  = QueueConsumed
	QueueStateCancelled = QueueCancelled
	QueueStatePromoted  = QueuePromoted
)

// QueueDelivery is the Pi command represented by one queue item.
type QueueDelivery string

const (
	QueuePrompt   QueueDelivery = "prompt"
	QueueSteer    QueueDelivery = "steer"
	QueueFollowUp QueueDelivery = "followUp"

	QueueDeliveryPrompt   = QueuePrompt
	QueueDeliverySteer    = QueueSteer
	QueueDeliveryFollowUp = QueueFollowUp
)

// QueueAttachment is the opaque attachment metadata owned by a queue item.
// Data is process-local and never crosses the browser control protocol.
type QueueAttachment struct {
	Ref       string `json:"ref"`
	Name      string `json:"name"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
	Data      []byte `json:"-"`
}

// QueueAttachmentResolver binds browser-owned opaque references to validated
// image bytes at the queue boundary. Implementations must claim all refs
// atomically before returning from ResolveAttachments.
type QueueAttachmentResolver interface {
	ResolveAttachments(context.Context, string, string, string, string, []string) ([]QueueAttachment, error)
	ReleaseAttachments(context.Context, string, string, string, string, []string) error
	CopyAttachments(context.Context, string, string, string, string, []QueueAttachment) ([]QueueAttachment, error)
}

// QueueItem is the public process-local queue record.
type QueueItem struct {
	ID           string            `json:"id"`
	Sid          string            `json:"sid"`
	SessionEpoch string            `json:"sessionEpoch"`
	Message      string            `json:"message"`
	Delivery     QueueDelivery     `json:"delivery"`
	Attachments  []QueueAttachment `json:"attachments"`
	State        QueueState        `json:"state"`
	Error        string            `json:"error,omitempty"`
	CreatedAt    int64             `json:"createdAt"`
}

// QueueSnapshot is the hydrate and queueChanged payload.
type QueueSnapshot struct {
	SessionEpoch string      `json:"sessionEpoch"`
	Items        []QueueItem `json:"items"`
}

var (
	ErrQueueItemIDRequired     = errors.New("queue itemId is required")
	ErrQueueSessionEpoch       = errors.New("queue sessionEpoch does not match this Pi instance")
	ErrQueueDelivery           = errors.New("queue delivery must be prompt, steer, or followUp")
	ErrQueueAttachments        = errors.New("queue attachments require an image resolver")
	ErrQueueItemNotFound       = errors.New("queue item not found")
	ErrQueueItemMismatch       = errors.New("queue item already exists with a different contract")
	ErrQueueDispatchUncertain  = errors.New("queue dispatch is blocked after uncertain delivery")
	ErrQueueItemAlreadyPiOwned = errors.New("queue item is Pi-owned and cannot be discarded")
)

func cloneQueueItem(item QueueItem) QueueItem {
	if item.Attachments == nil {
		item.Attachments = []QueueAttachment{}
	} else {
		cloned := make([]QueueAttachment, len(item.Attachments))
		for index, attachment := range item.Attachments {
			cloned[index] = attachment
			cloned[index].Data = append([]byte(nil), attachment.Data...)
		}
		item.Attachments = cloned
	}
	return item
}

func validQueueDelivery(delivery QueueDelivery) bool {
	switch delivery {
	case QueuePrompt, QueueSteer, QueueFollowUp:
		return true
	default:
		return false
	}
}

func (i *Instance) queueSnapshotLocked() QueueSnapshot {
	items := make([]QueueItem, 0, len(i.queueItems))
	for _, item := range i.queueItems {
		items = append(items, cloneQueueItem(item))
	}
	sort.SliceStable(items, func(left, right int) bool {
		if items[left].CreatedAt == items[right].CreatedAt {
			return items[left].ID < items[right].ID
		}
		return items[left].CreatedAt < items[right].CreatedAt
	})
	return QueueSnapshot{SessionEpoch: i.sessionEpoch, Items: items}
}

// QueueSnapshotCopy returns a deep copy of the process-local queue ledger.
func (i *Instance) QueueSnapshotCopy() QueueSnapshot {
	i.queueMu.Lock()
	defer i.queueMu.Unlock()
	return i.queueSnapshotLocked()
}

// QueueSessionEpoch returns the stable epoch for this live child.
func (i *Instance) QueueSessionEpoch() string {
	i.queueMu.Lock()
	defer i.queueMu.Unlock()
	return i.sessionEpoch
}

func (i *Instance) queueDepthLocked() int {
	depth := 0
	for _, item := range i.queueItems {
		switch item.State {
		case QueueCancelled, QueueConsumed:
			continue
		default:
			depth++
		}
	}
	return depth
}

func (i *Instance) setQueueDepth(depth int) {
	i.stateMu.Lock()
	i.state.QueueDepth = depth
	i.stateMu.Unlock()
}

func (i *Instance) emitQueueChanged(depth int) {
	i.setQueueDepth(depth)
	i.Emit(EvtQueueChanged, nil, i.QueueSnapshotCopy())
}

func queueAttachmentRefs(item QueueItem) []string {
	refs := make([]string, len(item.Attachments))
	for index, attachment := range item.Attachments {
		refs[index] = attachment.Ref
	}
	return refs
}

func (i *Instance) detachQueueClaimLocked(itemID string, retainRecovery bool) queueClaim {
	claim := i.queueClaims[itemID]
	if claim.options.Resolver == nil {
		return queueClaim{}
	}
	if retainRecovery {
		// Keep the resolver and owner for explicit uncertain recovery, but
		// return the still-claimed copy so the filesystem lease can be
		// released exactly once by the caller.
		claimToRelease := claim
		claim.leased = false
		i.queueClaims[itemID] = claim
		return claimToRelease
	}
	delete(i.queueClaims, itemID)
	return claim
}

func (i *Instance) releaseQueueClaim(claim queueClaim, item QueueItem) error {
	if !claim.leased || claim.options.Resolver == nil || len(item.Attachments) == 0 {
		return nil
	}
	return claim.options.Resolver.ReleaseAttachments(
		context.Background(),
		claim.options.Owner,
		i.ID,
		item.SessionEpoch,
		item.ID,
		queueAttachmentRefs(item),
	)
}

func sameQueueContract(item QueueItem, sessionEpoch string, message string, delivery QueueDelivery, attachmentRefs []string) bool {
	if item.SessionEpoch != sessionEpoch || item.Message != message || item.Delivery != delivery {
		return false
	}
	stored := queueAttachmentRefs(item)
	if len(stored) != len(attachmentRefs) {
		return false
	}
	for index := range stored {
		if stored[index] != attachmentRefs[index] {
			return false
		}
	}
	return true
}

func (i *Instance) nextLocalQueueItemLocked() string {
	if i.queueSending || i.queueBlocked {
		return ""
	}
	var next QueueItem
	found := false
	for _, item := range i.queueItems {
		if item.State != QueueLocal {
			continue
		}
		if !found || item.CreatedAt < next.CreatedAt || (item.CreatedAt == next.CreatedAt && item.ID < next.ID) {
			next = item
			found = true
		}
	}
	if !found {
		return ""
	}
	next.State = QueueSending
	i.queueItems[next.ID] = next
	i.queueSending = true
	return next.ID
}

// SubmitQueue creates one idempotent queue item and starts the single queue
// dispatcher when the instance has no item in flight. Attachment claiming is
// performed while the queue lock is held, so duplicate browser frames cannot
// transfer one provisional lease twice.
func (i *Instance) SubmitQueue(ctx context.Context, itemID, sessionEpoch, message string, delivery QueueDelivery, attachmentRefs []string, options ...QueueSubmitOptions) (QueueItem, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return QueueItem{}, err
	}
	if itemID == "" {
		return QueueItem{}, ErrQueueItemIDRequired
	}
	if sessionEpoch == "" {
		return QueueItem{}, ErrQueueSessionEpoch
	}
	if !validQueueDelivery(delivery) {
		return QueueItem{}, ErrQueueDelivery
	}
	attachmentRefs = append([]string{}, attachmentRefs...)
	var option QueueSubmitOptions
	if len(options) > 0 {
		option = options[0]
	}
	if len(attachmentRefs) != 0 && option.Resolver == nil {
		return QueueItem{}, ErrQueueAttachments
	}

	i.queueMu.Lock()
	if i.sessionEpoch == "" {
		// Direct test instances may not have gone through Manager.newInstance;
		// the first valid queue call establishes their local epoch.
		i.sessionEpoch = sessionEpoch
	}
	if sessionEpoch != i.sessionEpoch {
		i.queueMu.Unlock()
		return QueueItem{}, ErrQueueSessionEpoch
	}
	if i.queueItems == nil {
		i.queueItems = make(map[string]QueueItem)
	}
	if i.queueClaims == nil {
		i.queueClaims = make(map[string]queueClaim)
	}
	if existing, ok := i.queueItems[itemID]; ok {
		if !sameQueueContract(existing, sessionEpoch, message, delivery, attachmentRefs) {
			i.queueMu.Unlock()
			return QueueItem{}, ErrQueueItemMismatch
		}
		item := cloneQueueItem(existing)
		i.queueMu.Unlock()
		return item, nil
	}
	attachments := []QueueAttachment{}
	if len(attachmentRefs) > 0 {
		var err error
		attachments, err = option.Resolver.ResolveAttachments(ctx, option.Owner, i.ID, sessionEpoch, itemID, attachmentRefs)
		if err != nil {
			i.queueMu.Unlock()
			return QueueItem{}, err
		}
		if len(attachments) != len(attachmentRefs) {
			i.queueMu.Unlock()
			return QueueItem{}, errors.New("attachment resolver returned the wrong number of images")
		}
		for index, attachment := range attachments {
			if attachment.Ref != attachmentRefs[index] || attachment.MimeType == "" || len(attachment.Data) == 0 {
				i.queueMu.Unlock()
				return QueueItem{}, errors.New("attachment resolver returned invalid image metadata")
			}
		}
	}
	item := QueueItem{
		ID:           itemID,
		Sid:          i.ID,
		SessionEpoch: sessionEpoch,
		Message:      message,
		Delivery:     delivery,
		Attachments:  attachments,
		State:        QueueLocal,
		CreatedAt:    time.Now().UnixMilli(),
	}
	i.queueItems[itemID] = item
	if len(attachments) > 0 {
		i.queueClaims[itemID] = queueClaim{options: option, leased: true}
	}
	nextID := i.nextLocalQueueItemLocked()
	item = cloneQueueItem(i.queueItems[itemID])
	depth := i.queueDepthLocked()
	i.queueMu.Unlock()

	i.emitQueueChanged(depth)
	if nextID != "" {
		go i.dispatchQueueItem(nextID, false)
	}
	return item, nil
}

var errQueueItemNotDispatchable = errors.New("queue item is no longer dispatchable")

// requestQueueItem writes a queue command at the settlement boundary. The
// queue lock stays held across the serialized JSONL write so an
// agent_settled event cannot advance the generation between dispatch and the
// command's write boundary. It is released before waiting for Pi's response.
func (i *Instance) requestQueueItem(ctx context.Context, id string, promoted bool) (json.RawMessage, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	requestID := i.nextCommandID()
	waiter, err := i.registerWaiter(requestID)
	if err != nil {
		return nil, err
	}

	i.queueMu.Lock()
	item, ok := i.queueItems[id]
	if !ok || (promoted && item.State != QueuePromoted) || (!promoted && item.State != QueueSending) {
		i.queueMu.Unlock()
		i.removeWaiter(requestID, waiter)
		return nil, errQueueItemNotDispatchable
	}
	fields := map[string]any{"message": item.Message}
	if images := queueImages(item); len(images) > 0 {
		fields["images"] = images
	}
	command := item.Delivery
	if promoted {
		command = QueuePrompt
	}
	b, err := makeRequest(queueCommand(command), requestID, fields)
	if err == nil {
		i.writeMu.Lock()
		err = i.writeBytesLocked(b, false)
		if err == nil {
			// This is the first settlement generation that can own this
			// correlated command: the snapshot follows its complete write.
			if i.queueDispatchGenerations == nil {
				i.queueDispatchGenerations = make(map[string]uint64)
			}
			i.queueDispatchGenerations[id] = i.queueSettlementGeneration
		}
		i.writeMu.Unlock()
	}
	i.queueMu.Unlock()
	if err != nil {
		i.removeWaiter(requestID, waiter)
		return nil, err
	}
	return i.waitFor(ctx, requestID, waiter)
}

func queueCommand(delivery QueueDelivery) string {
	if delivery == QueueFollowUp {
		return "follow_up"
	}
	return string(delivery)
}

func queueUncertainError(err error) error {
	if err == nil {
		return ErrQueueDispatchUncertain
	}
	return fmt.Errorf("Pi acceptance uncertain; delivery was not confirmed: %w", err)
}

func isQueueUncertainError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrNotAlive) ||
		errors.Is(err, io.ErrClosedPipe) || errors.Is(err, io.ErrShortWrite) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "closed pipe") || strings.Contains(message, "broken pipe") || strings.Contains(message, "short write")
}

func queueImages(item QueueItem) []map[string]string {
	if len(item.Attachments) == 0 {
		return nil
	}
	images := make([]map[string]string, 0, len(item.Attachments))
	for _, attachment := range item.Attachments {
		images = append(images, map[string]string{
			"type":     "image",
			"data":     base64.StdEncoding.EncodeToString(attachment.Data),
			"mimeType": attachment.MimeType,
		})
	}
	return images
}

func (i *Instance) dispatchQueueItem(id string, promoted bool) {
	ctx, cancel := context.WithTimeout(context.Background(), queueAcceptanceTimeout)
	defer cancel()
	_, err := i.requestQueueItem(ctx, id, promoted)
	if errors.Is(err, errQueueItemNotDispatchable) {
		return
	}
	if err == nil {
		i.finishQueueAcceptance(id, promoted)
		return
	}
	if isQueueUncertainError(err) {
		i.finishQueueUncertain(id, queueUncertainError(err))
		return
	}
	i.finishQueueRejection(id, err)
}

func (i *Instance) finishQueueAcceptance(id string, promoted bool) {
	var claim queueClaim
	i.queueMu.Lock()
	item, ok := i.queueItems[id]
	if !ok {
		i.queueSending = false
		i.queueMu.Unlock()
		return
	}
	if promoted {
		if item.State != QueuePromoted {
			i.queueSending = false
			i.queueMu.Unlock()
			return
		}
	} else if item.State != QueueSending {
		i.queueSending = false
		i.queueMu.Unlock()
		return
	}
	dispatchGeneration, dispatched := i.queueDispatchGenerations[id]
	if dispatched && i.queueSettlementGeneration > dispatchGeneration {
		item.State = QueueConsumed
		item.Error = ""
		i.queueItems[id] = item
		delete(i.queueDispatchGenerations, id)
		claim = i.detachQueueClaimLocked(id, false)
	} else {
		// QueuePromoted is the replacement prompt's in-flight state. Once its
		// response is accepted, it follows the same post-response boundary as
		// a normal prompt and waits for the next agent_settled event.
		item.State = QueueAccepted
		item.Error = ""
		i.queueItems[id] = item
		delete(i.queueDispatchGenerations, id)
	}
	// Pi owns an accepted item until the correlated lifecycle reaches
	// agent_settled. Keep its claimed attachments through that boundary;
	// releasing on the acceptance response lets cleanup delete bytes while
	// Pi can still consume them. If the settle event was parsed first, the
	// generation check above closes that boundary atomically instead.
	i.queueSending = false
	nextID := i.nextLocalQueueItemLocked()
	depth := i.queueDepthLocked()
	i.queueMu.Unlock()
	_ = i.releaseQueueClaim(claim, item)
	i.emitQueueChanged(depth)
	if nextID != "" {
		go i.dispatchQueueItem(nextID, false)
	}
}

func (i *Instance) finishQueueUncertain(id string, err error) {
	var claim queueClaim
	i.queueMu.Lock()
	item, ok := i.queueItems[id]
	if !ok || (item.State != QueueSending && item.State != QueuePromoted) {
		i.queueMu.Unlock()
		return
	}
	item.State = QueueUncertain
	item.Error = err.Error()
	i.queueItems[id] = item
	delete(i.queueDispatchGenerations, id)
	claim = i.detachQueueClaimLocked(id, true)
	i.queueSending = false
	i.queueBlocked = true
	depth := i.queueDepthLocked()
	i.queueMu.Unlock()
	_ = i.releaseQueueClaim(claim, item)
	i.emitQueueChanged(depth)
}

func (i *Instance) finishQueueRejection(id string, err error) {
	i.queueMu.Lock()
	item, ok := i.queueItems[id]
	if !ok || (item.State != QueueSending && item.State != QueuePromoted) {
		i.queueMu.Unlock()
		return
	}
	delivery := item.Delivery
	promoted := item.State == QueuePromoted
	i.queueMu.Unlock()

	if delivery == QueueSteer && !promoted {
		ctx, cancel := context.WithTimeout(context.Background(), queueAcceptanceTimeout)
		data, stateErr := i.Request(ctx, "get_state", nil)
		cancel()
		if stateErr == nil && !queueStateBusy(data) {
			i.queueMu.Lock()
			item, ok = i.queueItems[id]
			promotedNow := ok && item.State == QueueSending
			if promotedNow {
				item.State = QueuePromoted
				item.Error = ""
				i.queueItems[id] = item
				// The rejected steer's dispatch generation must not settle
				// the promoted prompt before that prompt has been written.
				delete(i.queueDispatchGenerations, id)
			}
			depth := i.queueDepthLocked()
			i.queueMu.Unlock()
			if promotedNow {
				i.emitQueueChanged(depth)
				i.dispatchQueueItem(id, true)
				return
			}
		}
		if stateErr != nil {
			// The rejection itself is known, but a lost state probe leaves
			// the promotion boundary ambiguous. Preserve the item and its
			// in-memory attachment bytes for explicit recovery; never turn
			// this transport failure into an ordinary cancellation.
			uncertainErr := fmt.Errorf("steer rejected; session state could not be confirmed: %w", stateErr)
			i.finishQueueUncertain(id, queueUncertainError(uncertainErr))
			return
		}
		err = fmt.Errorf("steer rejected while Pi remained busy: %w", err)
	}

	var claim queueClaim
	i.queueMu.Lock()
	item, ok = i.queueItems[id]
	if !ok || (item.State != QueueSending && item.State != QueuePromoted) {
		i.queueMu.Unlock()
		return
	}
	item.State = QueueCancelled
	item.Error = err.Error()
	i.queueItems[id] = item
	delete(i.queueDispatchGenerations, id)
	claim = i.detachQueueClaimLocked(id, false)
	i.queueSending = false
	nextID := i.nextLocalQueueItemLocked()
	depth := i.queueDepthLocked()
	i.queueMu.Unlock()
	_ = i.releaseQueueClaim(claim, item)
	i.emitQueueChanged(depth)
	if nextID != "" {
		go i.dispatchQueueItem(nextID, false)
	}
}

func queueStateBusy(data json.RawMessage) bool {
	var state struct {
		Busy         *bool `json:"busy"`
		IsStreaming  *bool `json:"isStreaming"`
		IsCompacting *bool `json:"isCompacting"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return true
	}
	if state.Busy != nil {
		return *state.Busy
	}
	if state.IsStreaming != nil || state.IsCompacting != nil {
		return (state.IsStreaming != nil && *state.IsStreaming) || (state.IsCompacting != nil && *state.IsCompacting)
	}
	return true
}

// settleAcceptedQueueItems is the normal queue-consumption path. Pi guarantees
// that agent_settled follows the completed continuation queues, so every
// accepted Phi item can transition together without guessing from message
// text or queue_update arrays. QueuePromoted is deliberately excluded here:
// it remains pending until the replacement prompt response is handled. The
// acceptance path closes the race where Pi settles before its acceptance
// response by comparing settlement and dispatch generations.
func (i *Instance) settleAcceptedQueueItems() {
	type release struct {
		claim queueClaim
		item  QueueItem
	}
	var releases []release
	changed := false
	i.queueMu.Lock()
	i.queueSettlementGeneration++
	for id, item := range i.queueItems {
		// QueuePromoted is still awaiting the replacement prompt response;
		// only finishQueueAcceptance may consume it after that response.
		if item.State != QueueAccepted {
			continue
		}
		item.State = QueueConsumed
		i.queueItems[id] = item
		delete(i.queueDispatchGenerations, id)
		claim := i.detachQueueClaimLocked(id, false)
		if claim.options.Resolver != nil {
			releases = append(releases, release{claim: claim, item: cloneQueueItem(item)})
		}
		changed = true
	}
	depth := i.queueDepthLocked()
	i.queueMu.Unlock()
	for _, pending := range releases {
		_ = i.releaseQueueClaim(pending.claim, pending.item)
	}
	if changed {
		i.emitQueueChanged(depth)
	}
}

// reconcileQueueUpdate stores Pi's authoritative queue arrays. They have no
// item IDs, so this path deliberately never consumes a ledger item by text or
// position.
func (i *Instance) reconcileQueueUpdate(data json.RawMessage) {
	var update struct {
		Steering []string `json:"steering"`
		FollowUp []string `json:"followUp"`
	}
	if err := json.Unmarshal(data, &update); err != nil {
		return
	}
	i.queueMu.Lock()
	i.piSteering = append([]string{}, update.Steering...)
	i.piFollowUp = append([]string{}, update.FollowUp...)
	i.queueMu.Unlock()
}

func (i *Instance) markQueueUncertainOnExit() {
	type release struct {
		claim queueClaim
		item  QueueItem
	}
	var releases []release
	i.queueMu.Lock()
	var changed bool
	for id, item := range i.queueItems {
		switch item.State {
		case QueueSending, QueuePromoted:
			item.State = QueueUncertain
			item.Error = queueUncertainError(ErrNotAlive).Error()
			i.queueItems[id] = item
			delete(i.queueDispatchGenerations, id)
			// Preserve the in-memory bytes and resolver owner for explicit
			// QueueCopy recovery, while releasing the original filesystem
			// claim at this instance lifecycle boundary.
			claim := i.detachQueueClaimLocked(id, true)
			if claim.options.Resolver != nil && claim.leased {
				releases = append(releases, release{claim: claim, item: cloneQueueItem(item)})
			}
			changed = true
		case QueueLocal, QueueAccepted:
			delete(i.queueDispatchGenerations, id)
			// These items cannot continue against a dead child. Their claimed
			// files are no longer needed by Pi, so release them without
			// changing the visible item state.
			claim := i.detachQueueClaimLocked(id, false)
			if claim.options.Resolver != nil && claim.leased {
				releases = append(releases, release{claim: claim, item: cloneQueueItem(item)})
			}
		}
	}
	// No command can complete after the child exits. Clear the dispatcher
	// latch and every write-generation marker even when no item needed a
	// visible state transition.
	i.queueSending = false
	i.queueBlocked = true
	i.queueDispatchGenerations = nil
	depth := i.queueDepthLocked()
	i.queueMu.Unlock()
	for _, pending := range releases {
		_ = i.releaseQueueClaim(pending.claim, pending.item)
	}
	if changed {
		i.emitQueueChanged(depth)
	}
}

func (i *Instance) queueItemForOperation(itemID, sessionEpoch string) (QueueItem, error) {
	if itemID == "" {
		return QueueItem{}, ErrQueueItemIDRequired
	}
	i.queueMu.Lock()
	defer i.queueMu.Unlock()
	if sessionEpoch == "" || sessionEpoch != i.sessionEpoch {
		return QueueItem{}, ErrQueueSessionEpoch
	}
	item, ok := i.queueItems[itemID]
	if !ok {
		return QueueItem{}, ErrQueueItemNotFound
	}
	return cloneQueueItem(item), nil
}

func (i *Instance) queueClaimForOperation(itemID, owner string) (QueueSubmitOptions, error) {
	i.queueMu.Lock()
	defer i.queueMu.Unlock()
	claim := i.queueClaims[itemID]
	if claim.options.Resolver == nil {
		return claim.options, nil
	}
	if owner == "" || owner != claim.options.Owner {
		return QueueSubmitOptions{}, errors.New("attachment claim is not owned by this client")
	}
	return claim.options, nil
}

func queueOperationOptions(options []QueueSubmitOptions) QueueSubmitOptions {
	if len(options) == 0 {
		return QueueSubmitOptions{}
	}
	return options[0]
}

type queueCancelOutcome struct {
	item    QueueItem
	claim   queueClaim
	nextID  string
	depth   int
	changed bool
	reason  string
}

// cancelQueueItem performs the complete local/uncertain cancellation decision
// under queueMu. In particular, no caller can observe a local item and then
// race the dispatcher into sending it before this transition is committed.
func (i *Instance) cancelQueueItem(itemID, sessionEpoch, owner string, allowUncertain bool) (queueCancelOutcome, error) {
	i.queueMu.Lock()
	defer i.queueMu.Unlock()
	if sessionEpoch == "" || sessionEpoch != i.sessionEpoch {
		return queueCancelOutcome{}, ErrQueueSessionEpoch
	}
	item, ok := i.queueItems[itemID]
	if !ok {
		return queueCancelOutcome{reason: "missing"}, nil
	}
	if item.State == QueueAccepted || item.State == QueuePromoted || item.State == QueueConsumed {
		return queueCancelOutcome{item: cloneQueueItem(item), reason: "pi-owned"}, nil
	}
	if item.State == QueueSending {
		return queueCancelOutcome{item: cloneQueueItem(item), reason: "uncertain"}, nil
	}
	if item.State == QueueCancelled {
		return queueCancelOutcome{item: cloneQueueItem(item), reason: "cancelled"}, nil
	}
	if item.State != QueueLocal && !(allowUncertain && item.State == QueueUncertain) {
		return queueCancelOutcome{item: cloneQueueItem(item), reason: "uncertain"}, nil
	}
	claim := i.queueClaims[itemID]
	if claim.options.Resolver != nil && (owner == "" || owner != claim.options.Owner) {
		return queueCancelOutcome{}, errors.New("attachment claim is not owned by this client")
	}
	wasUncertain := item.State == QueueUncertain
	item.State = QueueCancelled
	i.queueItems[itemID] = item
	delete(i.queueDispatchGenerations, itemID)
	claim = i.detachQueueClaimLocked(itemID, false)
	if wasUncertain {
		i.queueBlocked = false
	}
	nextID := i.nextLocalQueueItemLocked()
	return queueCancelOutcome{
		item:    cloneQueueItem(item),
		claim:   claim,
		nextID:  nextID,
		depth:   i.queueDepthLocked(),
		changed: true,
	}, nil
}

// QueueRestore cancels only a Phi-owned local item and returns it for draft
// recovery. It never restores an accepted, uncertain, or sending Pi item.
func (i *Instance) QueueRestore(itemID, sessionEpoch string, options ...QueueSubmitOptions) (map[string]any, error) {
	outcome, err := i.cancelQueueItem(itemID, sessionEpoch, queueOperationOptions(options).Owner, false)
	if err != nil {
		return nil, err
	}
	if !outcome.changed {
		return map[string]any{"restored": false, "item": outcome.item, "reason": outcome.reason}, nil
	}
	if err := i.releaseQueueClaim(outcome.claim, outcome.item); err != nil {
		return nil, err
	}
	i.emitQueueChanged(outcome.depth)
	if outcome.nextID != "" {
		go i.dispatchQueueItem(outcome.nextID, false)
	}
	return map[string]any{"restored": true, "item": outcome.item}, nil
}

// QueueCopy returns a fresh unsent draft for an uncertain item without
// resubmitting it. Claimed images become fresh provisional references.
func (i *Instance) QueueCopy(itemID, sessionEpoch string, options ...QueueSubmitOptions) (map[string]any, error) {
	item, err := i.queueItemForOperation(itemID, sessionEpoch)
	if err != nil {
		if errors.Is(err, ErrQueueItemNotFound) {
			return map[string]any{"copied": false, "reason": "missing"}, nil
		}
		return nil, err
	}
	if item.State != QueueUncertain {
		return map[string]any{"copied": false, "reason": "not-uncertain", "item": item}, nil
	}
	claim, err := i.queueClaimForOperation(itemID, queueOperationOptions(options).Owner)
	if err != nil {
		return nil, err
	}
	refs := []string{}
	attachments := []QueueAttachment{}
	if claim.Resolver != nil && len(item.Attachments) > 0 {
		attachments, err = claim.Resolver.CopyAttachments(context.Background(), claim.Owner, i.ID, sessionEpoch, itemID, item.Attachments)
		if err != nil {
			return nil, err
		}
		refs = queueAttachmentRefs(QueueItem{Attachments: attachments})
	}
	return map[string]any{
		"copied":         true,
		"message":        item.Message,
		"attachmentRefs": refs,
		"attachments":    attachments,
	}, nil
}

// QueueDiscard marks a local or uncertain item cancelled. Accepted and
// consumed Pi-owned items remain visible because Pi has no dequeue protocol.
func (i *Instance) QueueDiscard(itemID, sessionEpoch string, options ...QueueSubmitOptions) (map[string]any, error) {
	outcome, err := i.cancelQueueItem(itemID, sessionEpoch, queueOperationOptions(options).Owner, true)
	if err != nil {
		return nil, err
	}
	if !outcome.changed {
		if outcome.reason == "uncertain" && outcome.item.State == QueueSending {
			return nil, ErrQueueItemAlreadyPiOwned
		}
		return map[string]any{"discarded": false, "item": outcome.item, "reason": outcome.reason}, nil
	}
	if err := i.releaseQueueClaim(outcome.claim, outcome.item); err != nil {
		return nil, err
	}
	i.emitQueueChanged(outcome.depth)
	if outcome.nextID != "" {
		go i.dispatchQueueItem(outcome.nextID, false)
	}
	return map[string]any{"discarded": true, "item": outcome.item}, nil
}
