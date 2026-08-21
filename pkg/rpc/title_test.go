package rpc

import "testing"

func TestTitleForSupplied(t *testing.T) {
	if got := TitleFor("/w/foo", "Custom"); got != "Custom" {
		t.Fatalf("got %q", got)
	}
}
func TestTitleForFallback(t *testing.T) {
	want := DefaultTitlePrefix + "foo"
	if got := TitleFor("/w/foo", ""); got != want {
		t.Fatalf("want %q got %q", want, got)
	}
}
func TestTitleForWindowsPath(t *testing.T) {
	want := DefaultTitlePrefix + "proj"
	if got := TitleFor(`C:\Users\me\proj`, ""); got != want {
		t.Fatalf("want %q got %q", want, got)
	}
}
