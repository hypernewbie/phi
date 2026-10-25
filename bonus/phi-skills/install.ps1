#Requires -Version 5.1
<#
.SYNOPSIS
    Install the Phi skills into every agent-harness skill directory present.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
#>
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

if (-not $HOME) { throw 'HOME is not set; cannot locate skill directories.' }

$source = $PSScriptRoot
$targets = [ordered]@{
    claude   = Join-Path $HOME '.claude/skills'
    pi       = Join-Path $HOME '.pi/agent/skills'
    codex    = Join-Path $HOME '.codex/skills'
    opencode = Join-Path $HOME '.config/opencode/skill'
}

$skills = Get-ChildItem -Path $source -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') }

foreach ($harness in $targets.Keys) {
    $dir = $targets[$harness]
    $parent = Split-Path -Parent $dir
    if (-not ((Test-Path -LiteralPath $dir -PathType Container) -or (Test-Path -LiteralPath $parent -PathType Container))) {
        Write-Host "skip: $harness ($dir not found)"
        continue
    }
    foreach ($skill in $skills) {
        $dest = Join-Path $dir $skill.Name
        if ($DryRun) {
            Write-Host "would install: $($skill.Name) -> $dest"
            continue
        }
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item -Path (Join-Path $skill.FullName '*') -Destination $dest -Recurse -Force
        Write-Host "installed: $($skill.Name) -> $dest"
    }
}
