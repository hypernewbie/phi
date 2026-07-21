package bindaddr

import (
	"net"
	"sort"
	"testing"
)

// withMockInterfaces swaps the interfaceAddrs seam for the duration of
// the test. Returns the restorer so the test body can call it via
// t.Cleanup. Every test that injects interfaces must call this —
// otherwise it leaks the mock into the next test.
func withMockInterfaces(t *testing.T, addrs []net.Addr, retErr error) {
	t.Helper()
	prev := interfaceAddrs
	interfaceAddrs = func() ([]net.Addr, error) {
		return addrs, retErr
	}
	t.Cleanup(func() {
		interfaceAddrs = prev
	})
}

// mockIPNet builds a *net.IPNet from a literal "192.168.1.5/24" or
// similar. Convenience so each test case stays one line.
func mockIPNet(s string) net.Addr {
	ip, ipnet, err := net.ParseCIDR(s)
	if err != nil {
		panic("mockIPNet: " + err.Error())
	}
	ipnet.IP = ip
	return ipnet
}

// TestClassify_LANBoundaries pins the RFC 1918 boundaries so a
// typo in the CIDR constant is caught immediately.
func TestClassify_LANBoundaries(t *testing.T) {
	allowed := []string{
		"10.0.0.0/8", "10.255.255.255/8", // 10/8 boundaries
		"172.16.0.0/12", "172.31.255.255/12", // 172.16/12 boundaries
		"192.168.0.0/16", "192.168.255.255/16", // 192.168/16 boundaries
	}
	rejected := []string{
		"9.255.255.255/8", "11.0.0.0/8", // just outside 10/8
		"172.15.255.255/12", "172.32.0.0/12", // just outside 172.16/12
		"192.167.255.255/16", "192.169.0.0/16", // just outside 192.168/16
	}
	for _, cidr := range allowed {
		ip, _, _ := net.ParseCIDR(cidr)
		if !containsAny(lanCIDRs, ip) {
			t.Errorf("expected %s to be in LAN range", cidr)
		}
	}
	for _, cidr := range rejected {
		ip, _, _ := net.ParseCIDR(cidr)
		if containsAny(lanCIDRs, ip) {
			t.Errorf("expected %s to be OUTSIDE LAN range", cidr)
		}
	}
}

// TestClassify_TailnetBoundaries pins the Tailscale CGNAT range.
func TestClassify_TailnetBoundaries(t *testing.T) {
	allowed := []string{
		"100.64.0.0/10", "100.127.255.255/10",
	}
	rejected := []string{
		"100.63.255.255/10", // one below the range
		"100.128.0.0/10",    // one above
		"100.0.0.0/8",       // wider CGNAT block — only 100.64/10 is Tailscale
	}
	for _, cidr := range allowed {
		ip, _, _ := net.ParseCIDR(cidr)
		if !tailnetCIDR.Contains(ip) {
			t.Errorf("expected %s in Tailnet range", cidr)
		}
	}
	for _, cidr := range rejected {
		ip, _, _ := net.ParseCIDR(cidr)
		if tailnetCIDR.Contains(ip) {
			t.Errorf("expected %s outside Tailnet range", cidr)
		}
	}
}

// TestClassify_PublicRejected — public IPs are never classified as
// LAN or Tailnet, even if they happen to be on a host interface
// (VPN endpoint, NAT external, etc.).
func TestClassify_PublicRejected(t *testing.T) {
	public := []string{
		"8.8.8.8/32",     // Google DNS
		"1.1.1.1/32",     // Cloudflare DNS
		"203.0.113.7/32", // TEST-NET-3
	}
	for _, cidr := range public {
		ip, _, _ := net.ParseCIDR(cidr)
		if containsAny(lanCIDRs, ip) || tailnetCIDR.Contains(ip) {
			t.Errorf("public IP %s must not be classified as LAN or Tailnet", cidr)
		}
	}
}

// TestClassify_LinkLocalRejected — Windows APIPA addresses
// (169.254/16) appear on disconnected interfaces and must NOT be
// served (they're not routable, and accepting on them confuses the
// banner).
func TestClassify_LinkLocalRejected(t *testing.T) {
	ip, _, _ := net.ParseCIDR("169.254.10.5/16")
	if containsAny(lanCIDRs, ip) || tailnetCIDR.Contains(ip) {
		t.Errorf("link-local 169.254/16 must not be classified as LAN or Tailnet")
	}
}

// TestDetect_AlwaysIncludesLoopbackFirst — even with zero injected
// interfaces or an error from the seam, loopback must be present and
// first. This is the F1 guarantee (architectural blocker).
func TestDetect_AlwaysIncludesLoopbackFirst(t *testing.T) {
	// Empty input.
	withMockInterfaces(t, nil, nil)
	got := Detect()
	if len(got) != 1 || got[0].Kind != Loopback || got[0].IP.String() != "127.0.0.1" {
		t.Fatalf("empty input: want [loopback], got %+v", got)
	}

	// Seam returns error.
	withMockInterfaces(t, nil, net.ErrClosed)
	got = Detect()
	if len(got) != 1 || got[0].Kind != Loopback {
		t.Fatalf("error from seam: want [loopback], got %+v", got)
	}
}

// TestDetect_MixedInterfaces — one of each kind plus the rejections.
// Only loopback + LAN + Tailnet survive.
func TestDetect_MixedInterfaces(t *testing.T) {
	addrs := []net.Addr{
		mockIPNet("192.168.1.42/24"),  // LAN
		mockIPNet("100.100.50.25/32"), // Tailnet
		mockIPNet("8.8.8.8/32"),       // public — rejected
		mockIPNet("169.254.0.1/16"),   // link-local — rejected
		mockIPNet("127.0.0.1/8"),      // loopback — skipped (added by Detect)
		mockIPNet("fe80::1/64"),       // IPv6 — rejected
		mockIPNet("10.0.0.5/8"),       // LAN
	}
	withMockInterfaces(t, addrs, nil)
	got := Detect()

	want := []Addr{
		{IP: net.IPv4(127, 0, 0, 1), Kind: Loopback},
		{IP: net.IPv4(10, 0, 0, 5), Kind: LAN},
		{IP: net.IPv4(192, 168, 1, 42), Kind: LAN},
		{IP: net.IPv4(100, 100, 50, 25), Kind: Tailnet},
	}
	if len(got) != len(want) {
		t.Fatalf("len: got %d want %d (%+v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i].IP.String() != want[i].IP.String() || got[i].Kind != want[i].Kind {
			t.Errorf("entry %d: got %+v want %+v", i, got[i], want[i])
		}
	}
}

// TestDetect_Dedup — the same IP appearing on two interfaces (e.g. a
// bonded NIC, or Windows reporting the same IPv4 on multiple
// adapters) must collapse to one entry.
func TestDetect_Dedup(t *testing.T) {
	addrs := []net.Addr{
		mockIPNet("192.168.1.42/24"),
		mockIPNet("192.168.1.42/24"), // exact duplicate
		mockIPNet("192.168.1.42/8"),  // same IP, different prefix — must still dedupe
	}
	withMockInterfaces(t, addrs, nil)
	got := Detect()
	count := 0
	for _, a := range got {
		if a.IP.Equal(net.IPv4(192, 168, 1, 42)) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("dedup failed: 192.168.1.42 appeared %d times in %+v", count, got)
	}
}

// TestDetect_DeterministicOrder — shuffled input must come out
// sorted: loopback, LAN ascending, Tailnet ascending. This pins the
// welcome banner's stability across restarts.
func TestDetect_DeterministicOrder(t *testing.T) {
	// Construct in deliberately reversed order.
	addrs := []net.Addr{
		mockIPNet("192.168.50.50/24"),
		mockIPNet("100.127.255.255/10"),
		mockIPNet("100.64.0.1/10"),
		mockIPNet("172.20.0.1/12"),
		mockIPNet("10.0.0.5/8"),
	}
	withMockInterfaces(t, addrs, nil)
	got := Detect()
	if len(got) != 6 {
		t.Fatalf("len: got %d want 6 (%+v)", len(got), got)
	}
	// Expected order: loopback, then LAN ascending, then Tailnet ascending.
	wantStrs := []string{
		"127.0.0.1",
		"10.0.0.5", "172.20.0.1", "192.168.50.50",
		"100.64.0.1", "100.127.255.255",
	}
	for i, want := range wantStrs {
		if got[i].IP.String() != want {
			t.Errorf("entry %d: got %s want %s", i, got[i].IP.String(), want)
		}
	}
}

// TestKindString — every Kind renders a stable label, unknown values
// don't panic.
func TestKindString(t *testing.T) {
	cases := map[Kind]string{
		Loopback: "local",
		LAN:      "LAN",
		Tailnet:  "Tailnet",
		Kind(99): "other",
	}
	for k, want := range cases {
		if got := k.String(); got != want {
			t.Errorf("Kind(%d).String() = %q, want %q", int(k), got, want)
		}
	}
}

// TestLessIP — the package-private comparator is used by sortByIP
// and is worth a direct test so future IPv6 additions don't break it.
func TestLessIP(t *testing.T) {
	ip := func(s string) net.IP {
		return net.ParseIP(s)
	}
	if !lessIP(ip("10.0.0.1"), ip("10.0.0.2")) {
		t.Error("10.0.0.1 < 10.0.0.2 should hold")
	}
	if lessIP(ip("192.168.1.1"), ip("10.0.0.1")) {
		t.Error("10.0.0.1 < 192.168.1.1 should hold")
	}
	if !lessIP(ip("100.64.0.1"), ip("100.64.0.2")) {
		t.Error("100.64.0.1 < 100.64.0.2 should hold")
	}
	// silence unused
	_ = sort.Slice
}
