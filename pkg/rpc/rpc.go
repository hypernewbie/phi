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
	OpGetAvailableModels         = "getAvailableModels"
	OpSetModel                   = "setModel"
	OpGetAvailableThinkingLevels = "getAvailableThinkingLevels"
	OpSetThinking                = "setThinking"
	OpNewSession                 = "newSession"
	OpAbort                      = "abort"

	EvtStateChanged    = "stateChanged"
	EvtMessageStart    = "messageStart"
	EvtMessageUpdate   = "messageUpdate"
	EvtMessageEnd      = "messageEnd"
	EvtTranscriptReset = "transcriptReset"
	EvtRpcExited       = "rpcExited"

	DefaultTitlePrefix = "Pi RPC · "
)

// P0StubbedFrames are control ops accepted but not implemented in P0.
// P2 removes this list.
var P0StubbedFrames = []string{
	"viewReady", "setCapabilities", "waitViewReady",
	"dlg", "dlgClosed", "activateTab",
}
