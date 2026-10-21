//go:build windows

package pibridge

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"strings"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// pipePrefix is the local pipe namespace Phi owns. Remote pipe hosts are
// never dialed or accepted.
const pipePrefix = `\\.\pipe\phi-pi-`

// NewEndpoint returns a local named-pipe endpoint with a random name of at
// least 128 bits. Root selection and path bounds do not apply on Windows.
func NewEndpoint() (*Endpoint, error) {
	return NewEndpointWithRoots(nil)
}

// NewEndpointWithRoots ignores roots on Windows; the endpoint is a pipe.
func NewEndpointWithRoots([]string) (*Endpoint, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return nil, fmt.Errorf("pibridge: rand: %w", err)
	}
	name := pipePrefix + hex.EncodeToString(buf[:])
	return &Endpoint{Target: "unix:" + name}, nil
}

// Listen opens the byte-mode pipe with an explicit current-user ACL.
// go-winio rejects remote clients and creates the pipe exclusively.
func (e *Endpoint) Listen() (net.Listener, error) {
	name, ok := strings.CutPrefix(e.Target, "unix:")
	if !ok || !strings.HasPrefix(name, pipePrefix) {
		return nil, fmt.Errorf("pibridge: endpoint is not a local pipe name")
	}
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return nil, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(name, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;" + user.User.Sid.String() + ")",
		MessageMode:        false,
		InputBufferSize:    65536,
		OutputBufferSize:   65536,
	})
}
