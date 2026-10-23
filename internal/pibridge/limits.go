package pibridge

import "time"

// Resource bounds from the reviewed plan (section 3.4). Change them only
// through a reviewed plan revision when acceptance behavior changes.
const (
	// ProtocolVersion is the only supported wire protocol version.
	ProtocolVersion uint32 = 1

	// maxHelloBytes bounds the application data of the first Hello message.
	maxHelloBytes = 16 * 1024
	// helloDeadline bounds the time from stream admission to a valid Hello.
	helloDeadline = 5 * time.Second
	// maxMetadataBytes bounds gRPC metadata (headers) per RPC.
	maxMetadataBytes = 8 * 1024
	// maxMessageBytes bounds one application message in either direction.
	maxMessageBytes = 256 * 1024
	// maxQueuedMessages bounds the outbound application queue per peer.
	maxQueuedMessages = 16
	// maxQueuedBytes bounds the outbound application queue bytes per peer.
	maxQueuedBytes = 256 * 1024
	// blockedSendTimeout stops a stream whose outbound write makes no
	// progress for this long.
	blockedSendTimeout = 5 * time.Second
	// maxJournalRecords bounds retained lifecycle records per runtime.
	maxJournalRecords = 64
	// shutdownDrainTimeout bounds gRPC drain before force-stop.
	shutdownDrainTimeout = 5 * time.Second

	// metadataTokenKey carries the hex-encoded per-process token.
	metadataTokenKey = "phi-pi-token"
	// metadataPaneKey carries the non-secret pane identity.
	metadataPaneKey = "phi-pi-pane"
	// metadataProcessKey carries the non-secret process identity.
	metadataProcessKey = "phi-pi-process"

	// CapabilityLifecycle is the lifecycle-event capability name.
	CapabilityLifecycle = "pi.lifecycle.v1"
	// CapabilityHistory is the on-demand editor-history capability name.
	CapabilityHistory = "pi.history.v1"
	// CapabilityModels is the on-demand model-list/switch capability name.
	CapabilityModels = "pi.models.v1"

	// maxHistoryPending bounds history requests awaiting replies per
	// peer. Excess callers fail fast into fallback; the map never
	// grows under a wedged or silent extension.
	maxHistoryPending = 4
	// maxModelsPending bounds models and set-model requests awaiting
	// replies per peer, each. Excess callers fail fast; the maps
	// never grow under a wedged or silent extension.
	maxModelsPending = 4
)
