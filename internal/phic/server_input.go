package phic

import (
	"fmt"
	"regexp"
	"strings"

	whatwg "github.com/nlnwa/whatwg-url/url"
)

var serverScheme = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*://`)
var decimalPort = regexp.MustCompile(`^[0-9]+$`)

// ECMAScript trim/split whitespace, not Go's broader Unicode White_Space.
// The desktop picker is the reference (desktop/electron/src/picker.html).
func jsWhitespace(r rune) bool {
	return (r >= 9 && r <= 13) || r == 32 || r == 0xa0 || r == 0x1680 || (r >= 0x2000 && r <= 0x200a) || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func jsTrim(s string) string { return strings.TrimFunc(s, jsWhitespace) }

// Match the actual Add Phi server form, not just Controller.parseEndpoint.
// WHATWG URL supplies the same browser normalization (IDNA, IPv4/IPv6,
// default ports, backslashes and dot segments); malformed tokens are skipped.
func parseServerURLs(raw string) []string {
	urls := make([]string, 0)
	for _, token := range strings.FieldsFunc(raw, jsWhitespace) {
		if !serverScheme.MatchString(token) {
			token = "http://" + token
		}
		u, err := whatwg.Parse(token)
		if err != nil {
			continue
		}
		if u.Port() == "" {
			u.SetPort("7070")
		}
		urls = append(urls, u.Href(false))
	}
	return urls
}

func validateServerInput(raw string) error {
	urls := parseServerURLs(raw)
	if len(urls) == 0 {
		return fmt.Errorf("Invalid server URL")
	}
	// Bulk desktop adds each valid server even when another fails. Single
	// failures stay in the form and show the controller's actual reason.
	if len(urls) == 1 {
		_, _, err := desktopEndpoint(urls[0])
		return err
	}
	return nil
}

type addServersResult struct {
	Profiles []desktopProfile
	Errors   []string
}

func (s *desktopStore) addServerInput(raw string) addServersResult {
	var result addServersResult
	for _, endpoint := range parseServerURLs(raw) {
		p, err := s.add(endpoint)
		if err != nil {
			result.Errors = append(result.Errors, endpoint+": "+err.Error())
			continue
		}
		result.Profiles = append(result.Profiles, p)
	}
	return result
}
