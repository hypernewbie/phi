//go:build !profiling

package ws

// The hooks below are compiled out of normal builds: the call sites stay,
// the counter storage does not.
func countJournalAppend(int) {}

func countJournalSync() {}

func countJournalSyncFailure() {}

func countJournalPendingRecovery() {}
