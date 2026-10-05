package termproof

import (
	"encoding/json"
	"testing"
)

// Export the actual candidate operations to the development-only headless
// oracle. No generated screen model is linked into cmd/phic.
func TestCandidateOracleInput(t *testing.T) {
	m := Mechanism1AltBuffer{}
	request, reply, err := newParserBarrier()
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(map[string]string{"open": string(m.Open()), "close": string(m.Close()), "barrier_request": string(request), "barrier_reply": string(reply)})
	if err != nil {
		t.Fatal(err)
	}
	t.Log("PHIC_SCREEN_OPERATIONS " + string(data))
}
