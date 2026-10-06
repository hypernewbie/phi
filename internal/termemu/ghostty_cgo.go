//go:build cgo && (((darwin || linux) && (amd64 || arm64)) || (windows && amd64))

package termemu

/*
#cgo darwin CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo darwin,arm64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/darwin-arm64/libghostty-vt.a -lm -lpthread
#cgo darwin,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/darwin-amd64/libghostty-vt.a -lm -lpthread
#cgo linux CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo linux,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/linux-amd64/libghostty-vt.a -lm -lpthread -ldl
#cgo linux,arm64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/linux-arm64/libghostty-vt.a -lm -lpthread -ldl
#cgo windows CFLAGS: -DGHOSTTY_STATIC -I${SRCDIR}/../../native/libghostty-vt/include
#cgo windows,amd64 LDFLAGS: ${SRCDIR}/../../native/libghostty-vt/windows-amd64/libghostty-vt.a
*/
import "C"

// This file owns the CGO directives that point the adapter at the pinned
// per-target static artifacts. The archives themselves are maintainer-built
// and committed with the headers and manifest. Normal CGO source installs
// link them without Zig, a runtime download, or a special build tag.
