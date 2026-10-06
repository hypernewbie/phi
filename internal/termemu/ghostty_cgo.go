//go:build termemu_ghostty

package termemu

/*
#cgo darwin CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo darwin,arm64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/darwin-arm64/libghostty-vt.a -lm -lpthread
#cgo darwin,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/darwin-amd64/libghostty-vt.a -lm -lpthread
#cgo linux CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo linux,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/linux-amd64/libghostty-vt.a -lm -lpthread -ldl
#cgo linux,arm64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/linux-arm64/libghostty-vt.a -lm -lpthread -ldl
#cgo windows CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo windows,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/windows-amd64/ghostty-vt-static.lib
*/
import "C"

// This file owns the CGO directives that point the adapter at the pinned
// per-target static artifacts. The archives themselves are maintainer-built
// and arrive locally (see native/libghostty-vt/README.md); the headers and
// manifest are committed. A build with -tags=termemu_ghostty on a target
// without an artifact fails at link time with the exact missing path, which
// is the declared build contract.
