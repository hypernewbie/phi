package rpc

// Frame and op identifiers. Exact strings; used by pkg/ws and tests.
const (
	ProtocolVersion = 1

	HelloFrame   = "hello"
	WelcomeFrame = "welcome"
	CallFrame    = "call"
	ResFrame     = "res"

	OpSpawn                      = "spawn"
	OpListSessions               = "listSessions"
	OpGetState                   = "getState"
	OpHydrate                    = "hydrate"
	OpGetMessages                = "getMessages"
	OpPrompt                     = "prompt"
	OpQueueSubmit                = "queueSubmit"
	OpQueueRestore               = "queueRestore"
	OpQueueCopy                  = "queueCopy"
	OpQueueDiscard               = "queueDiscard"
	OpExtensionUIResponse        = "extensionUiResponse"
	OpExtensionUICancel          = "extensionUiCancel"
	OpGetAvailableModels         = "getAvailableModels"
	OpSetModel                   = "setModel"
	OpGetAvailableThinkingLevels = "getAvailableThinkingLevels"
	OpSetThinking                = "setThinking"
	OpNewSession                 = "newSession"
	OpAbort                      = "abort"
	OpSetSessionName             = "setSessionName"
	OpSubagentTranscript         = "subagentTranscript"

	EvtStateChanged        = "stateChanged"
	EvtMessageStart        = "messageStart"
	EvtMessageUpdate       = "messageUpdate"
	EvtMessageEnd          = "messageEnd"
	EvtTranscriptReset     = "transcriptReset"
	EvtRpcExited           = "rpcExited"
	EvtSubagentFleet       = "subagentFleet"
	EvtToolExecutionUpdate = "toolExecutionUpdate"
	EvtQueueUpdate         = "queueUpdate"
	EvtQueueChanged        = "queueChanged"
	EvtExtensionUIRequest  = "extensionUiRequest"
	EvtExtensionUIClosed   = "extensionUiClosed"

	// Pi error/control surfaces mapped from pi's JSONL events so the
	// chat-pi frontend can render them with TUI parity. All are
	// raw-passthrough events: msg is nil, snapshot is untouched, only
	// the sequenced Evt carries through. Plan: 2026-08-22-0345.
	EvtAutoRetryStart              = "autoRetryStart"
	EvtAutoRetryEnd                = "autoRetryEnd"
	EvtCompactionEnd               = "compactionEnd"
	EvtExtensionError              = "extensionError"
	EvtSummarizationRetryScheduled = "summarizationRetryScheduled"
	EvtSummarizationRetryFinished  = "summarizationRetryFinished"

	DefaultTitlePrefix = "Pi RPC · "
)

// P0StubbedFrames are control ops accepted but not implemented in P0.
// P2 removes this list.
var P0StubbedFrames = []string{
	"viewReady", "setCapabilities", "waitViewReady",
	"dlg", "dlgClosed", "activateTab",
}
