package server

import (
	"net/http"

	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/internal/attachments"
	"github.com/hypernewbie/phi/pkg/ws"
)

// RegisterRoutes installs every HTTP and WebSocket route on the default
// mux. Handlers read the process state this package owns.
func RegisterRoutes() {
	http.HandleFunc("/api/auth/status", access.HandleAccessAuthStatus)
	http.HandleFunc("/api/auth/login", access.HandleAccessAuthLogin)
	http.HandleFunc("/api/auth/password", access.HandleAccessPassword)
	http.HandleFunc("/api/auth/v2/status", access.HandleAccessV2Status)
	http.HandleFunc("/api/auth/v2/login", access.HandleAccessV2Login)
	http.HandleFunc("/api/auth/v2/password", access.HandleAccessV2Password)
	http.HandleFunc("/api/auth/v2/refresh", access.HandleAccessV2Refresh)
	http.HandleFunc("/api/auth/v2/logout", access.HandleAccessV2Logout)
	http.HandleFunc("/api/coders", HandleGetCoders)
	http.HandleFunc("/api/sessions", HandleGetSessions)
	http.HandleFunc("/api/terminals", HandleSpawnTerminal)
	http.HandleFunc("/api/session-meta", HandleSessionMeta)
	http.HandleFunc("/api/diff", Git.HandleGetDiff)
	http.HandleFunc("/api/git/raw-diff", Git.HandleRawDiff)
	http.HandleFunc("/api/git/raw-status", Git.HandleRawStatus)
	http.HandleFunc("/api/git/raw-log", Git.HandleRawLog)
	http.HandleFunc("/api/git/commits", Git.HandleGetCommits)
	http.HandleFunc("/api/git/info", Git.HandleGitInfo)
	http.HandleFunc("/api/git/status-files", Git.HandleGitStatusFiles)
	http.HandleFunc("/api/git/action", Git.HandleGitAction)
	http.HandleFunc("/api/config", HandleConfig)
	http.HandleFunc("/api/config/pushover", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			HandleGetPushoverConfig(w, r)
		} else if r.Method == http.MethodPost {
			HandlePostPushoverConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/pushover/test", HandleTestPushover)
	http.HandleFunc("/api/config/webhook", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			HandleGetWebhookConfig(w, r)
		} else if r.Method == http.MethodPost {
			HandlePostWebhookConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/webhook/test", HandleTestWebhook)
	http.HandleFunc("/api/config/simplepush", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			HandleGetSimplepushConfig(w, r)
		} else if r.Method == http.MethodPost {
			HandlePostSimplepushConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/simplepush/test", HandleTestSimplepush)
	http.HandleFunc("/api/config/kanban-vault", HandleKanbanVault)
	http.HandleFunc("/api/config/export", HandleConfigExport)
	http.HandleFunc("/api/config/import", HandleConfigImport)
	http.HandleFunc("/api/config/export-models", HandleConfigExportModels)
	http.HandleFunc("/api/config/import-models", HandleConfigImportModels)
	http.HandleFunc("/api/config/export-quick-commands", HandleConfigExportQuickCommands)
	http.HandleFunc("/api/config/export-terminal-commands", HandleConfigExportTerminalCommands)
	http.HandleFunc("/api/config/import-cmds", HandleConfigImportCmds)
	http.HandleFunc("/api/config/workspaces", HandleWorkspaceToggle)
	http.HandleFunc("/api/config/models", HandleModelPresets)
	http.HandleFunc("/api/config/thinking-presets", HandleThinkingPresets)
	http.HandleFunc("/api/fs/autocomplete", HandleFSAutocomplete)
	http.HandleFunc("/api/fs/list", HandleFSList)
	http.HandleFunc("/api/fs/browse", HandleFSBrowse)
	http.HandleFunc("/api/config/theme", HandleThemeUpdate)
	http.HandleFunc("/api/config/appearance", HandleAppearanceUpdate)
	http.HandleFunc("/api/config/mobile-appearance", HandleMobileAppearance)
	http.HandleFunc("/api/config/mobile-appearance/fence", HandleMobileAppearanceFence)
	http.HandleFunc("/api/git/worktrees", HandleGetWorktrees)
	http.HandleFunc("/api/git/worktree-dirty", HandleGetWorktreeDirtyStates)
	http.HandleFunc("/api/config/worktree-state", HandleWorktreeStateUpdate)
	http.HandleFunc("/api/config/quick-commands", HandleQuickCommands)
	http.HandleFunc("/api/config/terminal-commands", HandleTerminalCommands)
	http.HandleFunc("/api/config/markdown-dirs", HandleMarkdownDirs)
	http.HandleFunc("/api/config/use-existing-terminal-tab", HandleUseExistingTerminalTab)
	http.HandleFunc("/api/config/use-hidden-terminal", HandleUseHiddenTerminal)
	http.HandleFunc("/api/cmd/run", HandleRunCommand)
	http.HandleFunc("/api/cmd/batch-run", HandleRunCommand)
	http.HandleFunc("/api/config/fast-mode", HandleFastMode)
	http.HandleFunc("/api/config/pi-offline", HandlePiOffline)
	http.HandleFunc("/api/config/pi-bridge-no-inject", HandlePiBridgeNoInject)
	http.HandleFunc("/api/config/claude-dangerously-skip-permissions", HandleClaudeDangerouslySkipPermissions)
	http.HandleFunc("/api/config/agy-theme-ansi", HandleAgyThemeAnsi)
	http.HandleFunc("/api/config/auto-reconnect", HandleAutoReconnect)
	http.HandleFunc("/api/opencode/service", HandleOpenCodeService)
	http.HandleFunc("/api/opencode/service/stop", HandleOpenCodeServiceStop)
	http.HandleFunc("/api/config/opencode-idle-stop", HandleOpenCodeIdleStop)
	http.HandleFunc("/api/markdown/files", HandleMarkdownFiles)
	http.HandleFunc("/api/markdown/file", HandleMarkdownFile)
	http.HandleFunc("/api/markdown/asset", HandleMarkdownAsset)
	http.HandleFunc("/api/file/asset", HandleFileAsset)
	http.HandleFunc("/api/markdown/paste", HandleMarkdownPaste)
	http.HandleFunc("/api/markdown/delete", HandleMarkdownDelete)
	http.HandleFunc("/api/markdown/copy-all-worktrees", HandleMarkdownCopyAllWorktrees)
	http.HandleFunc("/api/markdown/export-bundle", HandleMarkdownExportBundle)
	http.HandleFunc("/api/markdown/import-bundle", HandleMarkdownImportBundle)
	http.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, Hub)
	})
	http.HandleFunc("/api/prompt-history/append", HandlePromptHistoryAppend)
	http.HandleFunc("/api/prompt-history/recent", HandlePromptHistoryRecent)
	http.HandleFunc("/api/pi-history", Pi.HandlePiBridgeHistory)
	http.HandleFunc("/api/pi-bridge/models", Pi.HandlePiBridgeModels)
	http.HandleFunc("/api/pi-bridge/model", Pi.HandlePiBridgeSetModel)
	http.HandleFunc("/api/pi-bridge/thinking-levels", Pi.HandlePiBridgeThinkingLevels)
	http.HandleFunc("/api/pi-bridge/thinking", Pi.HandlePiBridgeSetThinking)
	http.HandleFunc("/api/pi-bridge/compact", Pi.HandlePiBridgeCompact)
	http.HandleFunc("/api/pi-bridge/reload", Pi.HandlePiBridgeReload)
	http.HandleFunc("/api/pi-bridge/skills", Pi.HandlePiBridgeSkills)
	http.HandleFunc("/api/pi-bridge/skill", Pi.HandlePiBridgeInvokeSkill)
	http.HandleFunc("/api/pi-bridge/attachments/context", Pi.HandlePiBridgeAttachmentContext)
	http.HandleFunc("/api/pi-bridge/attachments", Pi.HandlePiBridgeAttachments)
	http.HandleFunc("/api/attachments/v2/browse", attachments.HandleV2Browse)
	http.HandleFunc("/api/attachments/v2/server-items", attachments.HandleV2ServerItem)
	http.HandleFunc("/api/attachments/v2/items/", attachments.HandleV2Item)
	http.HandleFunc("/api/pi-bridge/transcript-search", Pi.HandlePiBridgeTranscriptSearch)
	http.HandleFunc("/api/attachments", attachments.HandleClipboard)
	http.HandleFunc("/api/clipboard", HandleGetClipboard)
	http.HandleFunc("/api/system/cpu", HandleSystemCPU)
	http.HandleFunc("/api/session-transcript", HandleGetSessionTranscript)
	http.HandleFunc("/api/proxy", HandleProxy)
	http.HandleFunc("/api/sync/messages/", HandleSyncMessages)
	http.HandleFunc("/api/sync/messages", HandleSyncMessages)
	http.HandleFunc("/api/config/sync-coordinator", HandleSyncCoordinator)
	http.HandleFunc("/api/version", HandleGetVersion)
	http.HandleFunc("/api/peers/status", HandleGetPeersStatus)
	http.HandleFunc("/api/config/peers", HandleConfigPeers)
	http.HandleFunc("/api/update/status", HandleUpdateStatus)
	http.HandleFunc("/api/update/check", HandleUpdateCheck)
	http.HandleFunc("/api/update/apply", HandleUpdateApply)
	http.HandleFunc("/api/update/progress", HandleUpdateProgress)
	http.HandleFunc("/api/restart", HandleRestart)
	http.HandleFunc("/api/diag", HandleDiag)
	http.HandleFunc("/livez", HandleLivez)
	http.HandleFunc("/healthz", HandleLivez) // alias
	http.HandleFunc("/readyz", HandleReadyz)
	http.HandleFunc("/", HandleFallback)
	http.HandleFunc("/ws/control", ws.HandleControl(Hub, RPC, func() string { return ActiveCWD }))
}
