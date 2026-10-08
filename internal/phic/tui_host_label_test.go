package phic

import "testing"

func TestDisplayHostnameMatchesWebSuffixRule(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"MacName.local", "MacName"},
		{"MacName.LOCAL", "MacName"},
		{"MacName.Local.", "MacName"},
		{"my.mac.local", "my.mac"},
		{"box.lan", "box.lan"},
		{".local", ".local"},
		{" MacName.local ", "MacName"},
		{"  ", ""},
	} {
		if got := displayHostname(tc.input); got != tc.want {
			t.Errorf("displayHostname(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestRailLabelHidesMacOSLocalSuffix(t *testing.T) {
	origin := "http://macname.local:7070"
	m := &tuiModel{data: map[string]*serverData{
		origin: {identity: serverIdentity{Hostname: "MacName.local"}},
	}}
	s := &serverState{profile: desktopProfile{Origin: origin, Name: "saved profile"}}
	if got := m.railLabel(s); got != "MACNAME" {
		t.Fatalf("rail label = %q, want MACNAME", got)
	}
}
