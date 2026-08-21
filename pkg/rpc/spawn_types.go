package rpc

import "io"

// Cmd is the subset of os/exec.Cmd Instance needs (*exec.Cmd satisfies it).
type Cmd interface {
	Wait() error
	Kill() error
}

// Aliases for readability.
type WriteCloser = io.WriteCloser
type ReadCloser = io.ReadCloser
