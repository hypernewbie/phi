#!/bin/bash
# Guard: Phi's added profiling implementation must compile out of normal
# builds and remain in -tags=profiling builds. Checks source selection,
# test selection, transitive dependencies, linked symbols, and Span output
# across no tags, profiling, otel, profiling+otel, embedassets, and
# embedassets+profiling. Usage: check-profiling-build.sh <new-output-dir>
set -euo pipefail
umask 077
if test "$#" -ne 1; then
  printf 'usage: %s <new-output-dir>\n' "$0" >&2
  exit 2
fi
OUT="$1"
if test -e "$OUT"; then
  printf 'output directory exists: %s\n' "$OUT" >&2
  exit 2
fi
mkdir -p -m 700 "$OUT"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

fail() { printf 'GUARD_FAIL: %s\n' "$1" >&2; exit 1; }
# have FILE LINE: FILE must contain exactly LINE.
have() { grep -Fxq "$2" "$1" || fail "$1 lacks $2"; }
# need FILE PATTERN: FILE must match PATTERN.
need() { grep -Eq "$2" "$1" || fail "$1 lacks $2"; }
# lack FILE PATTERN: FILE must not match PATTERN.
lack() { grep -Eq "$2" "$1" && fail "$1 contains $2" || true; }

PROFILING_GO='timing.go feature.go memory_stats.go memory_stats_profiling.go diagnostics_profiling.go'
DISABLED_GO='profiling_disabled.go diagnostics_disabled.go'
PROFILING_TEST='timing_test.go timing_nested_test.go timing_bench_test.go feature_profiling_test.go memory_stats_test.go memory_stats_profiling_test.go api_timing_test.go'

# check_variant LABEL WANT [GO LIST ARGS]: file/test/dep selection.
check_variant() {
  label="$1"; want="$2"; shift 2
  go list "$@" -f '{{.ImportPath}}{{"\n"}}{{join .GoFiles "\n"}}' . ./pkg/obs ./pkg/ws ./internal/termstate > "$OUT/$label-files.txt"
  go list "$@" -f '{{.ImportPath}}{{"\n"}}{{join .TestGoFiles "\n"}}{{"\n"}}{{join .XTestGoFiles "\n"}}' . ./pkg/obs ./pkg/ws ./internal/termstate > "$OUT/$label-tests.txt"
  # go list exits 1 when constraints exclude every file; that is the
  # expected empty selection for non-profiling variants.
  set +e
  go list "$@" -f '{{join .GoFiles "\n"}}' ./internal/diagnostics > "$OUT/$label-diag-files.txt" 2> "$OUT/$label-diag-err.txt"
  diag_status=$?
  set -e
  if test "$diag_status" -ne 0; then
    grep -Eq 'build constraints exclude all Go files' "$OUT/$label-diag-err.txt" || fail "go list diagnostics failed: $(cat "$OUT/$label-diag-err.txt")"
    : > "$OUT/$label-diag-files.txt"
  fi
  go list "$@" -deps . > "$OUT/$label-deps.txt"
  if test "$want" = yes; then
    for f in $PROFILING_GO; do have "$OUT/$label-files.txt" "$f"; done
    for f in $DISABLED_GO; do lack "$OUT/$label-files.txt" "^$f\$"; done
    for f in $PROFILING_TEST; do have "$OUT/$label-tests.txt" "$f"; done
    lack "$OUT/$label-tests.txt" '^profiling_disabled_test\.go$'
    test -s "$OUT/$label-diag-files.txt" || fail "$label diagnostics has no files"
    have "$OUT/$label-deps.txt" 'github.com/hypernewbie/phi/internal/diagnostics'
    have "$OUT/$label-deps.txt" 'github.com/google/pprof/profile'
  else
    for f in $PROFILING_GO; do lack "$OUT/$label-files.txt" "^$f\$"; done
    for f in $DISABLED_GO; do have "$OUT/$label-files.txt" "$f"; done
    for f in $PROFILING_TEST; do lack "$OUT/$label-tests.txt" "^$f\$"; done
    have "$OUT/$label-tests.txt" 'profiling_disabled_test.go'
    test -s "$OUT/$label-diag-files.txt" && fail "$label diagnostics unexpectedly selected" || true
    lack "$OUT/$label-deps.txt" '^github\.com/hypernewbie/phi/internal/diagnostics$'
    lack "$OUT/$label-deps.txt" '^github\.com/google/pprof/profile$'
  fi
  lack "$OUT/$label-deps.txt" '^net/http/pprof$'
  lack "$OUT/$label-deps.txt" '^github\.com/google/pprof/driver$'
}

check_variant default no
check_variant profiling yes -tags=profiling
check_variant otel no -tags=otel
check_variant both yes -tags=profiling,otel
check_variant release no -tags=embedassets
check_variant release-profiling yes -tags=embedassets,profiling

# OTel SDK follows the otel tag only.
lack "$OUT/default-deps.txt" 'go\.opentelemetry\.io/otel/sdk(/|$)'
lack "$OUT/profiling-deps.txt" 'go\.opentelemetry\.io/otel/sdk(/|$)'
lack "$OUT/release-deps.txt" 'go\.opentelemetry\.io/otel/sdk(/|$)'
need "$OUT/otel-deps.txt" 'go\.opentelemetry\.io/otel/sdk(/|$)'
need "$OUT/both-deps.txt" 'go\.opentelemetry\.io/otel/sdk(/|$)'

# check_binary LABEL [GO BUILD ARGS]: linked symbols for debug variants.
check_binary() {
  label="$1"; shift
  go build "$@" -o "$OUT/phi-$label" .
  go tool nm "$OUT/phi-$label" > "$OUT/$label.nm"
  # Positive control: the obs seam stays linked in every variant.
  need "$OUT/$label.nm" 'phi/pkg/obs\.DoFeature$'
  case "$label" in
    default|otel)
      lack "$OUT/$label.nm" 'phi/internal/diagnostics\.'
      # Only the two constant no-op hooks may carry timing names here; the
      # recorder file itself is already proven excluded by source selection.
      if grep -E 'phi/pkg/obs\.timing' "$OUT/$label.nm" | grep -Ev 'phi/pkg/obs\.timingSpan(Start|End)$' | grep -q .; then
        fail "$label links recorder timing symbols"
      fi
      lack "$OUT/$label.nm" 'phi/pkg/obs\.BeginTimingCapture'
      lack "$OUT/$label.nm" 'pprof/profile\.'
      go tool objdump -s 'github.com/hypernewbie/phi/pkg/obs.Span' "$OUT/phi-$label" > "$OUT/$label-span.asm"
      test -s "$OUT/$label-span.asm" || fail "$label Span disassembly empty"
      lack "$OUT/$label-span.asm" 'timingSpan|timingActive|timingMu'
      ;;
    profiling|both)
      need "$OUT/$label.nm" 'phi/pkg/obs\.timingActive$'
      need "$OUT/$label.nm" 'pprof/profile\.'
      ;;
  esac
}

check_binary default
check_binary profiling -tags=profiling
check_binary otel -tags=otel
check_binary both -tags=profiling,otel
printf 'PROFILING_PARTITION_OK out=%s\n' "$OUT"
