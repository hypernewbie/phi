// Package bindaddr determines which network addresses phi should bind
// to when running in its default "lan" mode. The goal is to avoid
// exposing the server on public interfaces (the internet at large),
// while still being reachable from the user's own machine, the local
// network, and Tailscale's tailnet.
//
// Classification is IPv4-only for v1 — see the comment in Detect for
// the IPv6 reasoning.
package bindaddr

import (
	"fmt"
	"net"
	"sort"
)

// Kind classifies a detected interface address so the welcome banner
// can label it ("local", "LAN", "Tailnet"). The numeric values are not
// load-bearing — use the String method.
type Kind int

const (
	// Loopback is the always-bound 127.0.0.1. It comes first so every
	// local script, bookmark, and health check pointed at localhost
	// keeps working regardless of what else is up.
	Loopback Kind = iota
	// LAN is an RFC 1918 private range (10/8, 172.16/12, 192.168/16).
	LAN
	// Tailnet is Tailscale's CGNAT range (100.64/10).
	Tailnet
)

// String returns a stable lower-case label suitable for log lines and
// the welcome banner ("local", "LAN", "Tailnet"). Unknown values fall
// back to "other" rather than panicking — the welcome banner must
// keep rendering even if a future Kind is added.
func (k Kind) String() string {
	switch k {
	case Loopback:
		return "local"
	case LAN:
		return "LAN"
	case Tailnet:
		return "Tailnet"
	default:
		return "other"
	}
}

// Addr is a single detected interface address with its classification.
// Use .IP.String() to print.
type Addr struct {
	IP   net.IP
	Kind Kind
}

// lanCIDRs and tailnetCIDR are the only ranges classified as "safe to
// bind". All other IPv4 addresses (public IPs, link-local 169.254/16
// APIPA, CGNAT 100.64/10 already covered by Tailscale) are excluded.
var (
	lanCIDRs = mustParseCIDRs(
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
	)
	tailnetCIDR = mustParseCIDR("100.64.0.0/10")
)

// interfaceAddrs is the test seam. Production reads from
// net.InterfaceAddrs; tests inject a fixed slice to exercise
// classification without touching the host's real interfaces.
var interfaceAddrs = net.InterfaceAddrs

// Detect returns the loopback address followed by every IPv4 interface
// address on the host that falls in an RFC 1918 range or the
// Tailscale CGNAT range. Returns at least the loopback entry even if
// the interface query fails or no LAN/Tailnet addresses are present,
// so the caller always has something to bind to.
//
// Ordering: loopback first, then LAN addresses sorted ascending by IP,
// then Tailnet addresses sorted ascending. The order is deterministic
// for a given interface set so the welcome banner is stable across
// restarts.
//
// IPv6 is intentionally excluded for v1: fe80::/10 link-local needs a
// zone ID in URLs (ugly and rarely useful), and 2000::/3 global IPv6
// is public (defeats the point). Tailscale also assigns fd7a:115c::/48
// ULA — a v2 candidate, not in this commit.
func Detect() []Addr {
	out := []Addr{{IP: net.IPv4(127, 0, 0, 1), Kind: Loopback}}

	addrs, err := interfaceAddrs()
	if err != nil {
		// Best-effort: if we can't read the interface table, still
		// return loopback so the server starts. The caller will log
		// the degraded state.
		return out
	}

	var lan, tail []Addr
	seen := map[string]bool{}
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip4 := ipnet.IP.To4()
		if ip4 == nil || ip4.IsLoopback() {
			continue
		}
		key := ip4.String()
		if seen[key] {
			continue
		}
		seen[key] = true
		switch {
		case tailnetCIDR.Contains(ip4):
			tail = append(tail, Addr{IP: ip4, Kind: Tailnet})
		case containsAny(lanCIDRs, ip4):
			lan = append(lan, Addr{IP: ip4, Kind: LAN})
		}
	}

	sortByIP(lan)
	sortByIP(tail)
	return append(append(out, lan...), tail...)
}

// containsAny returns true if ip is in any of the CIDRs.
func containsAny(cidrs []*net.IPNet, ip net.IP) bool {
	for _, n := range cidrs {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// sortByIP sorts ascending by IPv4 representation (lexicographic on
// the 4-byte form, which is correct for 32-bit IPv4 addresses).
func sortByIP(s []Addr) {
	sort.Slice(s, func(i, j int) bool {
		return lessIP(s[i].IP, s[j].IP)
	})
}

func lessIP(a, b net.IP) bool {
	ab := a.To4()
	bb := b.To4()
	if ab == nil || bb == nil {
		return a.String() < b.String()
	}
	for k := 0; k < 4; k++ {
		if ab[k] != bb[k] {
			return ab[k] < bb[k]
		}
	}
	return false
}

func mustParseCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(fmt.Sprintf("bindaddr: invalid CIDR %q: %v", s, err))
	}
	return n
}

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, s := range cidrs {
		out = append(out, mustParseCIDR(s))
	}
	return out
}
