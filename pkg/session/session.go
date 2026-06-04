package session

import (
	"os"
	"time"
)

type Session struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Cwd         string    `json:"cwd"`
	Coder       string    `json:"coder"`
	TimeUpdated time.Time `json:"time_updated"`
}

type Message struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

func expandHome(path string) string {
	if len(path) > 0 && path[0] == '~' {
		home, err := os.UserHomeDir()
		if err == nil {
			return home + path[1:]
		}
	}
	return path
}

func parseRawTime(val interface{}) time.Time {
	if val == nil {
		return time.Now()
	}
	switch v := val.(type) {
	case int64:
		if v > 2000000000 { // milliseconds
			return time.Unix(v/1000, (v%1000)*1000000)
		}
		return time.Unix(v, 0)
	case int:
		v64 := int64(v)
		if v64 > 2000000000 {
			return time.Unix(v64/1000, 0)
		}
		return time.Unix(v64, 0)
	case float64:
		return time.Unix(int64(v), 0)
	case string:
		for _, layout := range []string{
			time.RFC3339,
			"2006-01-02 15:04:05",
			"2006-01-02T15:04:05Z",
		} {
			if t, err := time.Parse(layout, v); err == nil {
				return t
			}
		}
	}
	return time.Now()
}
