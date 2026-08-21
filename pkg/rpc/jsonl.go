package rpc

import "bufio"

// ScannerBuffer is 10 MiB; longer lines fail the scan (treated as a crash).
const ScannerBuffer = 10 * 1024 * 1024

// LineScanner reads LF-delimited JSONL lines, stripping one trailing CR.
type LineScanner struct{ sc *bufio.Scanner }

// NewLineScanner wraps r.
func NewLineScanner(r ReadCloser) *LineScanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), ScannerBuffer)
	sc.Split(ScanLinesNoCR)
	return &LineScanner{sc: sc}
}

// ScanLinesNoCR splits on '\n' only and strips one trailing '\r'.
func ScanLinesNoCR(data []byte, atEOF bool) (int, []byte, error) {
	for j := 0; j < len(data); j++ {
		if data[j] == '\n' {
			line := data[:j]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			return j + 1, line, nil
		}
	}
	if atEOF && len(data) > 0 {
		line := data
		if line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		return len(data), line, nil
	}
	return 0, nil, nil
}

// Next returns the next line. ok=false at EOF or on a too-long line.
func (s *LineScanner) Next() (line []byte, ok bool, err error) {
	if s.sc.Scan() {
		return s.sc.Bytes(), true, nil
	}
	return nil, false, s.sc.Err()
}
