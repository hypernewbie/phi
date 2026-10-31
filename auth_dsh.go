//go:build dsh

package main

import (
	"net/http"
	"time"

	"github.com/hypernewbie/phi/internal/dshweb"
)

// admitDSH verifies Phi auth for one DSH request using the existing
// token-validation logic. It returns a generation/expiry lease snapshot
// taken under the same lock, never the raw cookie. Tagged with the carrier so
// the default build keeps no dshweb dependency.
func (m *accessAuthManager) admitDSH(r *http.Request) (dshweb.Lease, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if m.record == nil {
		return dshweb.Lease{Generation: m.generation, ExpiresAt: now.Add(accessSessionTTL)}, true
	}
	cookie, err := r.Cookie(accessSessionCookie)
	if err != nil || cookie.Value == "" {
		return dshweb.Lease{}, false
	}
	expiresAt, ok := m.verifiedSessionLocked(cookie.Value, now)
	if !ok {
		return dshweb.Lease{}, false
	}
	return dshweb.Lease{Generation: m.generation, ExpiresAt: expiresAt}, true
}
