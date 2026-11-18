package phicmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
)

// printJSON writes one JSON document to stdout. Field names are a
// contract; the golden tests pin them.
func printJSON(v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

// printNDJSON writes one JSON object per line for stream consumers.
func printNDJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

// table is a plain, no-colour, tab-aligned writer.
type table struct {
	w  *tabwriter.Writer
	tw io.Writer
}

func newTable(headers ...string) *table {
	tw := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintln(tw, strings.ToUpper(strings.Join(headers, "\t")))
	return &table{w: tw, tw: tw}
}

func (t *table) row(cells ...string) {
	fmt.Fprintln(t.w, strings.Join(cells, "\t"))
}

func (t *table) flush() { _ = t.w.Flush() }

// tailLines keeps the last n lines of s (0 keeps everything) and reports
// whether truncation happened.
func tailLines(s string, n int) (string, bool) {
	if n <= 0 {
		return s, false
	}
	lines := strings.Split(s, "\n")
	if len(lines) <= n {
		return s, false
	}
	return strings.Join(lines[len(lines)-n:], "\n"), true
}

// capString bounds a string to max bytes on a rune boundary, appending a
// marker when it truncates.
func capString(s string, max int64) (string, bool) {
	if max <= 0 || int64(len(s)) <= max {
		return s, false
	}
	cut := int(max)
	for cut > 0 && !strings.HasPrefix(s[cut:], "") {
		// fast path: byte cut, then back off to a rune boundary
		break
	}
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "\n… [phi-cmd: output truncated at max-bytes]", true
}

// kv prints a key/value block for human output.
func kv(pairs ...string) {
	for i := 0; i+1 < len(pairs); i += 2 {
		fmt.Printf("%s: %s\n", pairs[i], pairs[i+1])
	}
}
