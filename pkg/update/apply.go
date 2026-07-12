package update

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// Phase describes a stage of the update apply pipeline. The frontend
// polls GET /api/update/progress and renders based on Phase + Pct.
type Phase string

const (
	PhaseIdle       Phase = "idle"
	PhaseDownloading Phase = "downloading"
	PhaseVerifying  Phase = "verifying"
	PhaseExtracting Phase = "extracting"
	PhaseStaging    Phase = "staging"
	PhaseDone       Phase = "done"
	PhaseError      Phase = "error"
)

// Progress is the status snapshot of an in-flight or last-completed apply.
type Progress struct {
	Phase     Phase  `json:"phase"`
	Pct       int    `json:"pct"`
	Version   string `json:"version,omitempty"`
	OldPath   string `json:"old_path,omitempty"`
	Error     string `json:"error,omitempty"`
	StartedAt time.Time `json:"started_at,omitempty"`
	DoneAt    time.Time `json:"done_at,omitempty"`
}

// ApplyResult is the structured outcome of an apply operation.
type ApplyResult struct {
	Progress Progress
	Err      error
}

// Applier owns the swap-on-disk pipeline. Constructed once at startup;
// Apply is single-threaded via the inFlight mutex (refuses concurrent
// applies per plan §3.5).
type Applier struct {
	currentVersion string
	installMethod  string
	httpClient     *http.Client

	// progress is atomic so /api/update/progress can read without locking.
	progress atomic.Pointer[Progress]
	inFlight atomic.Bool
}

// NewApplier constructs an Applier with default HTTP timeout.
func NewApplier(currentVersion, installMethod string) *Applier {
	a := &Applier{
		currentVersion: currentVersion,
		installMethod:  installMethod,
		httpClient:     &http.Client{Timeout: 5 * time.Minute},
	}
	empty := Progress{Phase: PhaseIdle}
	a.progress.Store(&empty)
	return a
}

// Progress returns a snapshot of the current apply state.
func (a *Applier) Progress() Progress {
	if p := a.progress.Load(); p != nil {
		return *p
	}
	return Progress{Phase: PhaseIdle}
}

func (a *Applier) setProgress(p Progress) {
	a.progress.Store(&p)
}

// Eligible reports whether the install method allows staged swap.
// npm + standalone can update in place; go-install + dev cannot.
func (a *Applier) Eligible() bool {
	switch a.installMethod {
	case "npm", "standalone":
		return true
	}
	return false
}

// AssetFor returns the GitHub release asset filename for the current
// platform + target version. Matches goreleaser archives config:
// phi_{ver}_{os}_{arch}.{tar.gz|zip} for v{ver} tag.
func AssetFor(version, goos, goarch string) string {
	ext := ".tar.gz"
	if goos == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("phi_%s_%s_%s%s", version, goos, goarch, ext)
}

// ChecksumsAsset is the asset that lists sha256 hashes for one release.
const ChecksumsAsset = "checksums.txt"

// Apply performs the full T2 pipeline:
//   1. download asset + checksums.txt
//   2. verify sha256
//   3. extract binary to phi.new
//   4. atomic swap phi -> phi.old, phi.new -> phi
// Returns ApplyResult; on success the running install is untouched
// until the very last rename (plan R5: fail-closed).
func (a *Applier) Apply(targetVersion string) ApplyResult {
	if !a.inFlight.CompareAndSwap(false, true) {
		return ApplyResult{
			Progress: Progress{Phase: PhaseError, Error: "another apply is already in flight"},
			Err:      fmt.Errorf("concurrent apply rejected"),
		}
	}
	defer a.inFlight.Store(false)

	if !a.Eligible() {
		err := fmt.Errorf("install method %q does not support staged self-update", a.installMethod)
		a.setProgress(Progress{Phase: PhaseError, Error: err.Error()})
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	if targetVersion == "" || targetVersion == a.currentVersion {
		err := fmt.Errorf("refusing to apply: targetVersion=%q current=%q", targetVersion, a.currentVersion)
		a.setProgress(Progress{Phase: PhaseError, Error: err.Error()})
		return ApplyResult{Progress: a.Progress(), Err: err}
	}
	if isNewer(a.currentVersion, targetVersion) {
		err := fmt.Errorf("refusing to downgrade: current=%q target=%q", a.currentVersion, targetVersion)
		a.setProgress(Progress{Phase: PhaseError, Error: err.Error()})
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	exePath, err := swapTargetHook()
	if err != nil {
		err = fmt.Errorf("could not resolve own path: %w", err)
		a.setProgress(Progress{Phase: PhaseError, Error: err.Error()})
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	exeDir := filepath.Dir(exePath)
	exeName := filepath.Base(exePath)

	startedAt := time.Now()
	a.setProgress(Progress{Phase: PhaseDownloading, Version: targetVersion, Pct: 0, StartedAt: startedAt})

	// ── 1. Download asset ───────────────────────────────────────
	asset := AssetFor(targetVersion, runtime.GOOS, runtime.GOARCH)
	assetURL := fmt.Sprintf("https://github.com/hypernewbie/phi/releases/download/v%s/%s", targetVersion, asset)
	assetPath := filepath.Join(os.TempDir(), "phi-update-"+asset)
	if err := a.download(assetURL, assetPath, func(pct int) {
		// Don't overwrite StartedAt; merge.
		cur := a.Progress()
		cur.Pct = pct
		a.setProgress(cur)
	}); err != nil {
		a.failProgress(err)
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	// ── 2. Download checksums.txt + verify ─────────────────────
	a.setProgress(Progress{Phase: PhaseVerifying, Version: targetVersion, Pct: 100, StartedAt: startedAt})
	checksumsURL := fmt.Sprintf("https://github.com/hypernewbie/phi/releases/download/v%s/%s", targetVersion, ChecksumsAsset)
	checksumsPath := filepath.Join(os.TempDir(), "phi-update-checksums.txt")
	if err := a.download(checksumsURL, checksumsPath, nil); err != nil {
		os.Remove(assetPath)
		a.failProgress(err)
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	if err := verifyChecksum(assetPath, checksumsPath, asset); err != nil {
		os.Remove(assetPath)
		os.Remove(checksumsPath)
		a.failProgress(err)
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	// ── 3. Extract binary to phi.new ────────────────────────────
	a.setProgress(Progress{Phase: PhaseExtracting, Version: targetVersion, Pct: 100, StartedAt: startedAt})
	binaryName := "phi"
	if runtime.GOOS == "windows" {
		binaryName = "phi.exe"
	}
	tmpExtractDir := filepath.Join(os.TempDir(), "phi-update-extract")
	_ = os.RemoveAll(tmpExtractDir)
	if err := extractBinary(assetPath, tmpExtractDir, binaryName); err != nil {
		os.Remove(assetPath)
		os.Remove(checksumsPath)
		a.failProgress(err)
		return ApplyResult{Progress: a.Progress(), Err: err}
	}
	extracted := filepath.Join(tmpExtractDir, binaryName)

	newPath := filepath.Join(exeDir, exeName+".new")
	if err := copyFile(extracted, newPath, 0755); err != nil {
		os.Remove(assetPath)
		os.Remove(checksumsPath)
		os.RemoveAll(tmpExtractDir)
		a.failProgress(err)
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	// ── 4. Atomic swap: exe -> exe.old, exe.new -> exe ──────────
	a.setProgress(Progress{Phase: PhaseStaging, Version: targetVersion, Pct: 100, StartedAt: startedAt})
	oldPath := filepath.Join(exeDir, exeName+".old")
	// Remove any leftover .old from a previous incomplete swap.
	_ = os.Remove(oldPath)

	// exe -> exe.old (rename of running file works on Windows + Unix;
	// the kernel keeps the old inode alive until the process exits).
	if err := os.Rename(exePath, oldPath); err != nil {
		os.Remove(newPath)
		os.Remove(assetPath)
		os.Remove(checksumsPath)
		os.RemoveAll(tmpExtractDir)
		a.failProgress(fmt.Errorf("stage swap (rename exe to .old): %w", err))
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	if err := os.Rename(newPath, exePath); err != nil {
		// Try to roll back the first rename.
		_ = os.Rename(oldPath, exePath)
		os.Remove(newPath)
		os.Remove(assetPath)
		os.Remove(checksumsPath)
		os.RemoveAll(tmpExtractDir)
		a.failProgress(fmt.Errorf("stage swap (rename .new to exe): %w", err))
		return ApplyResult{Progress: a.Progress(), Err: err}
	}

	// Clean up staging files.
	os.Remove(assetPath)
	os.Remove(checksumsPath)
	os.RemoveAll(tmpExtractDir)

	a.setProgress(Progress{
		Phase:     PhaseDone,
		Pct:       100,
		Version:   targetVersion,
		OldPath:   oldPath,
		StartedAt: startedAt,
		DoneAt:    time.Now(),
	})
	return ApplyResult{Progress: a.Progress()}
}

func (a *Applier) failProgress(err error) {
	cur := a.Progress()
	cur.Phase = PhaseError
	cur.Error = err.Error()
	a.setProgress(cur)
}

// download fetches a URL to a local file. Optional onPct is called with
// 0-100 as bytes stream in.
func (a *Applier) download(url, dest string, onPct func(int)) error {
	resp, err := a.httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d for %s", resp.StatusCode, url)
	}

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()

	if onPct != nil && resp.ContentLength > 0 {
		// Stream with progress.
		buf := make([]byte, 32*1024)
		var total int64
		lastPct := -1
		for {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := out.Write(buf[:n]); werr != nil {
					return werr
				}
				total += int64(n)
				pct := int(total * 100 / resp.ContentLength)
				if pct != lastPct {
					lastPct = pct
					onPct(pct)
				}
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				return rerr
			}
		}
	} else {
		// No content-length known — just copy.
		if _, err := io.Copy(out, resp.Body); err != nil {
			return err
		}
		if onPct != nil {
			onPct(100)
		}
	}
	return nil
}

// verifyChecksum reads checksumsPath, finds the line for asset, and
// compares the SHA256 of assetPath to the expected hash. Fails closed
// (plan R5): any error = reject.
func verifyChecksum(assetPath, checksumsPath, asset string) error {
	expected, err := lookupChecksum(checksumsPath, asset)
	if err != nil {
		return err
	}
	f, err := os.Open(assetPath)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, expected) {
		return fmt.Errorf("checksum mismatch for %s: expected %s got %s", asset, expected, got)
	}
	return nil
}

// lookupChecksum parses goreleaser's checksums.txt format
// ("<sha>  <filename>") and returns the hash for asset, case-insensitive.
func lookupChecksum(checksumsPath, asset string) (string, error) {
	f, err := os.Open(checksumsPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) != 2 {
			continue
		}
		hash, name := parts[0], parts[1]
		// Allow leading "./" or path prefix on filename.
		name = strings.TrimPrefix(name, "./")
		if strings.EqualFold(filepath.Base(name), asset) {
			return hash, nil
		}
	}
	return "", fmt.Errorf("checksum entry for %s not found in %s", asset, checksumsPath)
}

// extractBinary pulls binaryName out of assetPath (zip or tar.gz).
func extractBinary(assetPath, destDir, binaryName string) error {
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return err
	}
	if strings.HasSuffix(assetPath, ".zip") {
		return extractZip(assetPath, destDir, binaryName)
	}
	return extractTarGz(assetPath, destDir, binaryName)
}

func extractZip(archive, destDir, binaryName string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		if filepath.Base(f.Name) != binaryName {
			continue
		}
		if f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		out, err := os.OpenFile(filepath.Join(destDir, binaryName), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
		if err != nil {
			return err
		}
		defer out.Close()
		if _, err := io.Copy(out, rc); err != nil {
			return err
		}
		return out.Close()
	}
	return fmt.Errorf("binary %s not found in %s", binaryName, archive)
}

func extractTarGz(archive, destDir, binaryName string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if filepath.Base(hdr.Name) != binaryName {
			continue
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		out, err := os.OpenFile(filepath.Join(destDir, binaryName), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
		if err != nil {
			return err
		}
		defer out.Close()
		if _, err := io.Copy(out, tr); err != nil {
			return err
		}
		return out.Close()
	}
	return fmt.Errorf("binary %s not found in %s", binaryName, archive)
}

// copyFile copies src to dst with the given mode. Used to drop the
// extracted binary next to the running exe before the rename dance.
func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

// swapTargetHook returns the path to the running binary that should
// be swapped. Default is os.Executable(). Tests override this to point
// at a fixture exe without having to mess with the test binary itself.
var swapTargetHook = func() (string, error) { return os.Executable() }

// CleanupOldBinary removes a stale `phi.old` left over from a previous
// successful apply. Safe to call on every boot; no-op if absent.
// Returns the path of the removed file (or "" if nothing was removed).
func CleanupOldBinary() (string, error) {
	exePath, err := swapTargetHook()
	if err != nil {
		return "", err
	}
	old := exePath + ".old"
	if _, err := os.Stat(old); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if err := os.Remove(old); err != nil {
		return "", err
	}
	return old, nil
}