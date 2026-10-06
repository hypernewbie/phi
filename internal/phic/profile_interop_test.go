package phic

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

// The desktop test invokes this compiled Go test helper against its own temp
// store. It exercises the production Go reader/writer, never a second schema.
func TestDesktopProfileInteropHelper(t *testing.T) {
	input := os.Getenv("PHIC_PROFILE_INTEROP")
	if input == "" {
		return
	}
	var request struct{ Path, Operation, URL, ID, Name, BeforeID string }
	if err := json.Unmarshal([]byte(input), &request); err != nil {
		t.Fatal(err)
	}
	store, err := desktopStoreFor(config{Profiles: request.Path})
	if err != nil {
		t.Fatal(err)
	}
	switch request.Operation {
	case "add":
		if _, err := store.add(request.URL); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "used":
		if err := store.setLastUsed(request.ID); err != nil {
			t.Fatal(err)
		}
	case "rename":
		if err := store.rename(request.ID, request.Name); err != nil {
			t.Fatal(err)
		}
	case "remove":
		if err := store.remove(request.ID); err != nil {
			t.Fatal(err)
		}
	case "reorder":
		if err := store.reorder(request.ID, request.BeforeID); err != nil {
			t.Fatal(err)
		}
	case "load":
	default:
		t.Fatal("unknown interop operation")
	}
	d, err := store.read()
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(struct {
		Path     string
		Profiles []desktopProfile
	}{store.path, d.profiles()})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(string(data))
	os.Exit(0)
}
