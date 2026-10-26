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
	// CapabilityThinking is the native thinking read/set capability name.
	CapabilityThinking = "pi.thinking.v1"
	// CapabilityContext is the context-telemetry capability name.
	CapabilityContext = "pi.context.v1"
	// CapabilityCompact is the native-compaction capability name.
	CapabilityCompact = "pi.compact.v1"
	// CapabilitySkills is the on-demand skill list/invocation capability name.
	CapabilitySkills = "pi.skills.v1"

	// maxHistoryPending bounds history requests awaiting replies per
	// peer. Excess callers fail fast into fallback; the map never
	// grows under a wedged or silent extension.
	maxHistoryPending = 4
	// maxModelsPending bounds models and set-model requests awaiting
	// replies per peer, each. Excess callers fail fast; the maps
	// never grow under a wedged or silent extension.
	maxModelsPending = 4
	// maxThinkingPending bounds thinking list and set requests per peer,
	// each, independently.
	maxThinkingPending = 4
	maxThinkingLevels  = 7
	maxThinkingField   = 256
	maxThinkingLevel   = 16

	// maxSkillsPending bounds skill list and invocation requests per
	// peer, each, independently. Excess callers fail fast; the maps
	// never grow under a wedged or silent extension.
	maxSkillsPending = 4
	// maxSkillEntries caps one skill list; a longer list is truncated
	// and flagged, never silently partial.
	maxSkillEntries = 200
	// maxSkillNameBytes and maxSkillDescriptionBytes are the wire
	// bounds for one skill entry, in UTF-8 bytes. Pi validates
	// character counts and only warns, so a loaded skill can exceed
	// them.
	maxSkillNameBytes        = 64
	maxSkillDescriptionBytes = 1024
)
