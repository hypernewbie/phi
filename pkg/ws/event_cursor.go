package ws

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// Event cursors fence replay pages: a page request carries the cursor that
// certifies its end, so a stale reader can never mistake a recycled seq for
// the byte it saw. The encoding is versioned so a format change is a hard
// rejection, never a misread.
const eventCursorVersion = "v1"
const maxEventCursorLen = 128

// EncodeEventCursor renders an (epoch, pos, ordinal) fence as one opaque
// token. Epoch scopes a pane lifetime; pos is the byte position; ordinal
// counts geometry changes so a resize cannot alias an old position.
func EncodeEventCursor(epoch, pos, ordinal uint64) string {
	return eventCursorVersion + "." + strconv.FormatUint(epoch, 10) + "." + strconv.FormatUint(pos, 10) + "." + strconv.FormatUint(ordinal, 10)
}

// ParseEventCursor validates an encoded cursor. Anything malformed is a
// bad request, never an expired boundary.
func ParseEventCursor(s string) (epoch, pos, ordinal uint64, err error) {
	if len(s) == 0 || len(s) > maxEventCursorLen {
		return 0, 0, 0, fmt.Errorf("invalid event cursor")
	}
	parts := strings.Split(s, ".")
	if len(parts) != 4 || parts[0] != eventCursorVersion {
		return 0, 0, 0, fmt.Errorf("invalid event cursor")
	}
	vals := make([]uint64, 3)
	for i, p := range parts[1:] {
		v, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return 0, 0, 0, fmt.Errorf("invalid event cursor")
		}
		vals[i] = v
	}
	return vals[0], vals[1], vals[2], nil
}

// syncDir runs the post-rename durability barrier on a directory. A failed
// barrier only delays durability; the next sweep retries it.
func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		// Windows opens directories with FILE_LIST_DIRECTORY (read-only), so
		// FlushFileBuffers (d.Sync) returns ERROR_ACCESS_DENIED.
		return d.Close()
	}
	syncErr := d.Sync()
	closeErr := d.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}
