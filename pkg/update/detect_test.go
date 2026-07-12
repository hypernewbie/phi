package update

import (
	"testing"
)

func TestDetect(t *testing.T) {
	tests := []struct {
		name        string
		buildSource string
		exePath     string
		goSum       string
		expected    string
	}{
		{
			name:        "npm install on windows",
			buildSource: "release",
			exePath:     `C:\Users\username\AppData\Roaming\npm\node_modules\@hypernewbie\phi-code\bin\phi.exe`,
			goSum:       "",
			expected:    "npm",
		},
		{
			name:        "npm install on unix",
			buildSource: "release",
			exePath:     `/usr/local/lib/node_modules/@hypernewbie/phi-code/bin/phi`,
			goSum:       "",
			expected:    "npm",
		},
		{
			name:        "standalone release binary",
			buildSource: "release",
			exePath:     `/usr/local/bin/phi`,
			goSum:       "",
			expected:    "standalone",
		},
		{
			name:        "go install latest",
			buildSource: "source",
			exePath:     `/home/user/go/bin/phi`,
			goSum:       "h1:someHashValue",
			expected:    "go-install",
		},
		{
			name:        "local dev source build",
			buildSource: "source",
			exePath:     `/code/phi/phi`,
			goSum:       "",
			expected:    "dev",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := detect(tc.buildSource, tc.exePath, tc.goSum)
			if got != tc.expected {
				t.Errorf("detect(%q, %q, %q) = %q; want %q", tc.buildSource, tc.exePath, tc.goSum, got, tc.expected)
			}
		})
	}
}
