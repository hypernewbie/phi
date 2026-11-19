package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"
	"unicode/utf8"
)

const (
	maxSyncTopicKeyBytes        = 256
	maxSyncTopicPostBytes       = 128 * 1024
	maxSyncTopicBatchTextBytes  = 64 * 1024
	maxSyncTopicBatches         = 1024
	maxSyncTopicBatchesPerOwner = 32
	maxSyncTopicSubscriptions   = 1024
	maxSyncTopicIDBytes         = 128
	syncTopicBatchWindow        = 5 * time.Second
)

var (
	errSyncTopicCapacity = errors.New("sync topic capacity")
	errSyncTopicTooLarge = errors.New("sync topic value too large")
	errSyncTopicInvalid  = errors.New("sync topic invalid")
)

type syncTopicOwner struct {
	paneID     string
	processID  string
	generation uint64
	runtimeID  string
	sessionID  string
	remote     bool
	peerID     string
	remoteSend func(*syncTopicBatch) error
	subs       map[string]struct{}
	batches    []*syncTopicBatch
	open       map[string]*syncTopicBatch
}

type syncTopicPost struct {
	postID string
	value  string
}

type syncTopicBatch struct {
	id       string
	seq      uint64
	topic    string
	posts    []syncTopicPost
	deadline time.Time
	created  time.Time
	sealed   bool
	sent     bool
	sentAt   time.Time
	text     []byte
}

type syncTopicBatchText struct {
	Topic     string              `json:"topic"`
	BatchID   string              `json:"batch_id"`
	PostCount int                 `json:"post_count"`
	Posts     []syncTopicPostText `json:"posts"`
}

type syncTopicPostText struct {
	PostID string `json:"post_id"`
	Value  string `json:"value"`
}

type syncTopicDelivery struct {
	owner syncTopicOwner
	batch *syncTopicBatch
}

type syncTopicEngine struct {
	epoch        string
	now          func() time.Time
	nextBatch    uint64
	nextPost     uint64
	owners       map[string]*syncTopicOwner
	byTopic      map[string]map[string]struct{}
	remoteReady  map[string]bool
	totalSubs    int
	totalBatches int
}

func newSyncTopicEngine(epoch string) *syncTopicEngine {
	if epoch == "" {
		epoch = randomSyncEpoch()
	}
	return &syncTopicEngine{
		epoch:       epoch,
		now:         time.Now,
		owners:      make(map[string]*syncTopicOwner),
		byTopic:     make(map[string]map[string]struct{}),
		remoteReady: make(map[string]bool),
	}
}

func randomSyncEpoch() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("epoch-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

func syncTopicOwnerKey(owner syncTopicOwner) string {
	return owner.paneID + "\x00" + owner.processID
}

func cloneSyncTopicOwner(owner *syncTopicOwner) syncTopicOwner {
	return syncTopicOwner{
		paneID: owner.paneID, processID: owner.processID,
		generation: owner.generation, runtimeID: owner.runtimeID, sessionID: owner.sessionID,
		remote: owner.remote, peerID: owner.peerID, remoteSend: owner.remoteSend,
	}
}

func (e *syncTopicEngine) subscribeLocked(owner syncTopicOwner, topic string) error {
	if topic == "" || len(topic) > maxSyncTopicKeyBytes || !utf8.ValidString(topic) {
		return errSyncTopicInvalid
	}
	key := syncTopicOwnerKey(owner)
	o := e.owners[key]
	if o != nil && (o.remote || o.generation != owner.generation ||
		o.runtimeID != owner.runtimeID || o.sessionID != owner.sessionID) {
		e.retireLocked(key)
		o = nil
	}
	if o != nil {
		o.remoteSend = owner.remoteSend
		if _, ok := o.subs[topic]; ok {
			return nil
		}
	}
	if e.totalSubs >= maxSyncTopicSubscriptions {
		return errSyncTopicCapacity
	}
	if o == nil {
		o = &syncTopicOwner{
			paneID: owner.paneID, processID: owner.processID,
			generation: owner.generation, runtimeID: owner.runtimeID, sessionID: owner.sessionID,
			subs: make(map[string]struct{}), open: make(map[string]*syncTopicBatch),
		}
		e.owners[key] = o
	}
	o.remoteSend = owner.remoteSend
	o.subs[topic] = struct{}{}
	set := e.byTopic[topic]
	if set == nil {
		set = make(map[string]struct{})
		e.byTopic[topic] = set
	}
	set[key] = struct{}{}
	e.totalSubs++
	return nil
}

// admitPostLocked reserves one post in every subscriber's FIFO before the
// caller mutates the board. Any recipient without room refuses the whole
// post. The caller holds app.syncMu.
func (e *syncTopicEngine) admitPostLocked(topic, value string, now time.Time) (bool, error) {
	if topic == "" || len(topic) > maxSyncTopicKeyBytes || !utf8.ValidString(topic) {
		return false, errSyncTopicInvalid
	}
	if len(value) > maxSyncTopicPostBytes || !utf8.ValidString(value) {
		return false, errSyncTopicInvalid
	}
	recipients := e.byTopic[topic]
	if len(recipients) == 0 {
		return false, nil
	}
	type plan struct {
		owner *syncTopicOwner
		batch *syncTopicBatch
		fresh bool
	}
	plans := make([]plan, 0, len(recipients))
	for key := range recipients {
		o := e.owners[key]
		if o == nil {
			continue
		}
		b := o.open[topic]
		if b != nil && !b.sealed && now.Before(b.deadline) {
			candidate := *b
			candidate.posts = append(append([]syncTopicPost{}, b.posts...), syncTopicPost{postID: "post-00000000000000000000", value: value})
			candidate.text = marshalSyncTopicBatch(&candidate)
			if len(candidate.text) > maxSyncTopicBatchTextBytes {
				return false, errSyncTopicTooLarge
			}
			plans = append(plans, plan{owner: o, batch: b})
			continue
		}
		if len(o.batches) >= maxSyncTopicBatchesPerOwner || e.totalBatches >= maxSyncTopicBatches {
			return false, errSyncTopicCapacity
		}
		candidate := &syncTopicBatch{
			id: "batch-00000000000000000000", seq: 1, topic: topic,
			posts:    []syncTopicPost{{postID: "post-00000000000000000000", value: value}},
			deadline: now.Add(syncTopicBatchWindow), created: now,
		}
		candidate.text = marshalSyncTopicBatch(candidate)
		if len(candidate.text) > maxSyncTopicBatchTextBytes {
			return false, errSyncTopicTooLarge
		}
		plans = append(plans, plan{owner: o, batch: nil, fresh: true})
	}
	if len(plans) == 0 {
		return false, nil
	}
	fresh := 0
	for _, p := range plans {
		if p.fresh {
			fresh++
		}
	}
	if fresh > 0 && (e.nextBatch > math.MaxUint64-uint64(fresh) || e.totalBatches+fresh > maxSyncTopicBatches) {
		return false, errSyncTopicCapacity
	}
	if e.nextPost == math.MaxUint64 {
		return false, errSyncTopicCapacity
	}
	postID := e.allocPostID()
	for _, p := range plans {
		if p.fresh {
			if expired := p.owner.open[topic]; expired != nil {
				expired.sealed = true
			}
			e.nextBatch++
			b := &syncTopicBatch{
				id: fmt.Sprintf("batch-%020d", e.nextBatch), seq: e.nextBatch, topic: topic,
				posts:    []syncTopicPost{{postID: postID, value: value}},
				deadline: now.Add(syncTopicBatchWindow), created: now,
			}
			b.text = marshalSyncTopicBatch(b)
			p.owner.batches = append(p.owner.batches, b)
			p.owner.open[topic] = b
			e.totalBatches++
			continue
		}
		p.batch.posts = append(p.batch.posts, syncTopicPost{postID: postID, value: value})
		p.batch.text = marshalSyncTopicBatch(p.batch)
	}
	return true, nil
}

func (e *syncTopicEngine) allocPostID() string {
	e.nextPost++
	if e.nextPost == 0 {
		e.nextPost = 1
	}
	return fmt.Sprintf("post-%020d", e.nextPost)
}

func marshalSyncTopicBatch(b *syncTopicBatch) []byte {
	posts := make([]syncTopicPostText, 0, len(b.posts))
	for _, post := range b.posts {
		posts = append(posts, syncTopicPostText{PostID: post.postID, Value: post.value})
	}
	text, err := json.Marshal(syncTopicBatchText{
		Topic: b.topic, BatchID: b.id, PostCount: len(posts), Posts: posts,
	})
	if err != nil {
		return nil
	}
	return text
}

// pumpLocked seals expired open batches and returns at most one sealed head
// per owner. The caller dispatches after releasing app.syncMu and then calls
// markSentLocked or markUnsentLocked.
func (e *syncTopicEngine) pumpLocked(now time.Time) []syncTopicDelivery {
	for _, o := range e.owners {
		for topic, b := range o.open {
			if !b.sealed && !now.Before(b.deadline) {
				b.sealed = true
				delete(o.open, topic)
			}
		}
	}
	var out []syncTopicDelivery
	for _, o := range e.owners {
		if o.remote && !e.remoteReady[o.peerID] {
			continue
		}
		for _, b := range o.batches {
			if !b.sealed {
				break
			}
			if b.sent && now.Sub(b.sentAt) < 500*time.Millisecond {
				break
			}
			out = append(out, syncTopicDelivery{owner: cloneSyncTopicOwner(o), batch: b})
			break
		}
	}
	return out
}

func (e *syncTopicEngine) markSentLocked(owner syncTopicOwner, batchID string, now time.Time) {
	o := e.owners[syncTopicOwnerKey(owner)]
	if o == nil {
		return
	}
	for _, b := range o.batches {
		if b.id == batchID {
			b.sent = true
			b.sentAt = now
			return
		}
	}
}

func (e *syncTopicEngine) markUnsentLocked(owner syncTopicOwner, batchID string) {
	o := e.owners[syncTopicOwnerKey(owner)]
	if o == nil {
		return
	}
	for _, b := range o.batches {
		if b.id == batchID {
			b.sent = false
			b.sentAt = time.Time{}
			return
		}
	}
}

// acknowledgeLocked releases exactly the matching owner FIFO head.
func (e *syncTopicEngine) acknowledgeLocked(owner syncTopicOwner, epoch string, seq uint64, batchID string) bool {
	if epoch != e.epoch || batchID == "" {
		return false
	}
	o := e.owners[syncTopicOwnerKey(owner)]
	if o == nil || len(o.batches) == 0 {
		return false
	}
	head := o.batches[0]
	if head.id != batchID || head.seq != seq {
		return false
	}
	o.batches = o.batches[1:]
	if o.open[head.topic] == head {
		delete(o.open, head.topic)
	}
	e.totalBatches--
	return true
}

// retireLocked cancels all subscriptions and pending work for one owner.
func (e *syncTopicEngine) retireLocked(key string) {
	o := e.owners[key]
	if o == nil {
		return
	}
	for topic := range o.subs {
		set := e.byTopic[topic]
		if set != nil {
			delete(set, key)
			if len(set) == 0 {
				delete(e.byTopic, topic)
			}
		}
	}
	e.totalSubs -= len(o.subs)
	e.totalBatches -= len(o.batches)
	delete(e.owners, key)
}

// retireOwnerLocked cancels every topic and batch for the captured owner.
func (e *syncTopicEngine) retireOwnerLocked(owner syncTopicOwner) {
	key := syncTopicOwnerKey(owner)
	o := e.owners[key]
	if o == nil || o.generation != owner.generation ||
		o.runtimeID != owner.runtimeID || o.sessionID != owner.sessionID {
		return
	}
	e.retireLocked(key)
}

// retireGenerationLocked cancels a local owner only when the captured tuple
// is still registered. A delayed fence or retirement marker cannot cancel a
// fresh replacement owner that reused the pane and process identity.
func (e *syncTopicEngine) retireGenerationLocked(owner syncTopicOwner) bool {
	key := syncTopicOwnerKey(owner)
	o := e.owners[key]
	if o == nil || o.remote || o.generation != owner.generation ||
		o.runtimeID != owner.runtimeID || o.sessionID != owner.sessionID {
		return false
	}
	e.retireLocked(key)
	return true
}

// subscribeRemoteLocked registers one owner whose delivery leaves this Phi.
func (e *syncTopicEngine) subscribeRemoteLocked(owner syncTopicOwner, topic string) error {
	if !owner.remote || owner.peerID == "" || owner.remoteSend == nil ||
		topic == "" || len(topic) > maxSyncTopicKeyBytes || !utf8.ValidString(topic) {
		return errSyncTopicInvalid
	}
	key := syncTopicOwnerKey(owner)
	o := e.owners[key]
	if o != nil && (!o.remote || o.peerID != owner.peerID ||
		o.generation != owner.generation || o.runtimeID != owner.runtimeID || o.sessionID != owner.sessionID) {
		e.retireLocked(key)
		o = nil
	}
	if o != nil {
		o.remoteSend = owner.remoteSend
		if _, ok := o.subs[topic]; ok {
			return nil
		}
	}
	if e.totalSubs >= maxSyncTopicSubscriptions {
		return errSyncTopicCapacity
	}
	if o == nil {
		o = &syncTopicOwner{
			paneID: owner.paneID, processID: owner.processID,
			generation: owner.generation, runtimeID: owner.runtimeID, sessionID: owner.sessionID,
			remote: true, peerID: owner.peerID, remoteSend: owner.remoteSend,
			subs: make(map[string]struct{}), open: make(map[string]*syncTopicBatch),
		}
		e.owners[key] = o
	}
	o.remoteSend = owner.remoteSend
	o.subs[topic] = struct{}{}
	set := e.byTopic[topic]
	if set == nil {
		set = make(map[string]struct{})
		e.byTopic[topic] = set
	}
	set[key] = struct{}{}
	e.totalSubs++
	return nil
}

// retirePeerLocked drops every remote owner from one cohort.
func (e *syncTopicEngine) retirePeerLocked(peerID string) {
	for key, o := range e.owners {
		if o.remote && o.peerID == peerID {
			e.retireLocked(key)
		}
	}
	delete(e.remoteReady, peerID)
}

func (e *syncTopicEngine) markRemoteReadyLocked(peerID string, ready bool) {
	if ready {
		e.remoteReady[peerID] = true
		return
	}
	delete(e.remoteReady, peerID)
}

func (e *syncTopicEngine) statsLocked() (owners, subs, batches int) {
	return len(e.owners), e.totalSubs, e.totalBatches
}
