package server

import "errors"

// errNoConfigStore reports a handler running before main installed the store.
var errNoConfigStore = errors.New("server: config store is not installed")
