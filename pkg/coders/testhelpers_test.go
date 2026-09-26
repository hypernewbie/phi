package coders

import (
	"encoding/json"
	"strings"
)

// jsonStrictDecode mirrors the loader's strict-decode policy so tests
// can drive CoderPatch the same way the production loader does. The
// loader rejects unknown fields; tests must too, otherwise a typo in
// a future field name could silently disappear.
func jsonStrictDecode(raw []byte, v any) error {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}
