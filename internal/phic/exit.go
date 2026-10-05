package phic

import "fmt"

// ExitError reports the raw backend status after all retained output drains.
type ExitError struct{ Code int }

func (e *ExitError) Error() string { return fmt.Sprintf("backend exited with status %d", e.Code) }
