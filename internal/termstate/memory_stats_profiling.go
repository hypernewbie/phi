//go:build profiling

package termstate

/*
#include <ghostty/vt.h>
*/
import "C"

import "unsafe"

// ResidentMemoryBytes reports native screen-page and image memory, excluding
// other terminal allocations and allocator overhead. Call under the pane lock.
func (t *Terminal) ResidentMemoryBytes() (uint64, error) {
	if t == nil || t.handle == nil {
		return 0, nil
	}
	var usage C.GhosttyTerminalMemoryUsage
	usage.size = C.size_t(C.sizeof_GhosttyTerminalMemoryUsage)
	if rc := C.ghostty_terminal_get(t.handle, C.GHOSTTY_TERMINAL_DATA_MEMORY_USAGE, unsafe.Pointer(&usage)); rc != C.GHOSTTY_SUCCESS {
		return 0, statusErr("ghostty_terminal_get", rc)
	}
	return uint64(usage.primary_resident_bytes + usage.alternate_resident_bytes +
		usage.primary_image_bytes + usage.alternate_image_bytes), nil
}
