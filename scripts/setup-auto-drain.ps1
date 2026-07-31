# setup-auto-drain.ps1
#
# One-time setup: registers the Windows scheduled task
# "TaskPilot\AmbientDeliberate" which fires every 5 minutes and runs the
# ambient-deliberate skill against the local TaskPilot deliberation queue.
#
# The task:
#   - runs as the current user only (not SYSTEM), so it can read the
#     Claude Code OAuth from the Windows Credential Manager (DPAPI)
#   - is hidden (no console flash) by going through powershell.exe with
#     -WindowStyle Hidden
#   - only fires while the user is logged on (DPAPI requirement)
#   - has a 10-minute hard kill so a hung Claude run can't pile up
#
# Usage (from an unelevated PowerShell):
#   .\scripts\setup-auto-drain.ps1
#
# Pass `-SkipDryRun` to skip the pre-flight Claude invocation (faster
# re-installs once you've confirmed the CLI works). Pass `-Force` to
# overwrite an existing task without prompting.
#
# This script never touches Anthropic's billing or API keys. It only
# wires Windows Task Scheduler to invoke the locally installed Claude
# Code CLI, which uses the user's existing subscription auth.

[CmdletBinding()]
param(
    [switch]$SkipDryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$TaskName       = 'TaskPilot\AmbientDeliberate'
$TaskFolder     = '\TaskPilot'
$TaskLeaf       = 'AmbientDeliberate'
$RepoRoot       = Split-Path -Parent $PSScriptRoot
$WrapperScript  = Join-Path $RepoRoot 'scripts\run-ambient-deliberate.ps1'
$LogPath        = Join-Path $env:USERPROFILE '.taskpilot\logs\auto-drain.log'

Write-Host ""
Write-Host "TaskPilot auto-drain setup" -ForegroundColor Cyan
Write-Host "=========================="
Write-Host ""

# ---------------------------------------------------------------------------
# 1. Sanity-check the wrapper script exists.
# ---------------------------------------------------------------------------
if (-not (Test-Path $WrapperScript)) {
    Write-Error "Wrapper script not found at $WrapperScript. Did you clone the repo correctly?"
    exit 1
}
Write-Host "  [OK] wrapper script found at $WrapperScript"

# ---------------------------------------------------------------------------
# 2. Locate the Claude Code CLI and validate it runs.
# ---------------------------------------------------------------------------
$claudeRoot = Join-Path $env:APPDATA 'Claude\claude-code'
if (-not (Test-Path $claudeRoot)) {
    Write-Host ""
    Write-Host "  [FAIL] Claude Code CLI not installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install Claude Code Desktop from:"
    Write-Host "    https://docs.anthropic.com/en/docs/claude-code/quickstart"
    Write-Host ""
    Write-Host "  After install, run 'claude /login' in a fresh terminal to authenticate."
    exit 1
}

$newest = Get-ChildItem -Path $claudeRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object -Property @{ Expression = { [version]$_.Name } } -Descending |
    Select-Object -First 1

if (-not $newest) {
    Write-Error "Claude Code install dir $claudeRoot exists but contains no versioned subdirs. Reinstall Claude Code Desktop."
    exit 1
}

$claude = Join-Path $newest.FullName 'claude.exe'
if (-not (Test-Path $claude)) {
    Write-Error "claude.exe missing under $($newest.FullName). Reinstall Claude Code Desktop."
    exit 1
}
Write-Host "  [OK] claude.exe found at version $($newest.Name)"

# Version probe -- also exercises the binary so we fail early on a broken install.
try {
    $version = & $claude --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "claude --version exited $LASTEXITCODE. Output:`n$version"
        exit 1
    }
    Write-Host "  [OK] claude --version => $version"
} catch {
    Write-Error "Failed to invoke claude.exe: $_"
    exit 1
}

# ---------------------------------------------------------------------------
# 3. Dry-run the headless invocation to confirm auth + skill autoload.
#    We use a trivial prompt that doesn't actually touch the queue, just
#    asks claude to echo a string. If this fails the user is not logged
#    in (or some other config snag) -- we surface that BEFORE registering.
# ---------------------------------------------------------------------------
if (-not $SkipDryRun) {
    Write-Host ""
    Write-Host "  Running pre-flight check (this may take ~10s)..."
    try {
        $probe = & $claude -p "Reply with exactly the word OK and nothing else." `
            --permission-mode bypassPermissions `
            --output-format text `
            --no-session-persistence 2>&1
        $probeExit = $LASTEXITCODE

        if ($probeExit -ne 0) {
            Write-Host ""
            Write-Host "  [FAIL] Pre-flight invocation exited $probeExit." -ForegroundColor Red
            Write-Host ""
            Write-Host "  Output:" -ForegroundColor Yellow
            Write-Host ($probe -join [Environment]::NewLine)
            Write-Host ""
            if ($probe -match '(?i)login|auth|unauthor') {
                Write-Host "  Looks like an auth issue. Run 'claude /login' in a terminal, then retry." -ForegroundColor Yellow
            }
            exit 1
        }
        Write-Host "  [OK] pre-flight invocation succeeded"
    } catch {
        Write-Error "Pre-flight invocation threw: $_"
        exit 1
    }
} else {
    Write-Host "  [SKIP] pre-flight dry-run (--SkipDryRun)"
}

# ---------------------------------------------------------------------------
# 4. Check for an existing registration.
# ---------------------------------------------------------------------------
$existing = Get-ScheduledTask -TaskName $TaskLeaf -TaskPath "$TaskFolder\" -ErrorAction SilentlyContinue
if ($existing) {
    if (-not $Force) {
        Write-Host ""
        Write-Host "  Task $TaskName already exists." -ForegroundColor Yellow
        $resp = Read-Host "  Overwrite? [y/N]"
        if ($resp -notmatch '^[yY]') {
            Write-Host "  Aborted." -ForegroundColor Yellow
            exit 0
        }
    }
    Unregister-ScheduledTask -TaskName $TaskLeaf -TaskPath "$TaskFolder\" -Confirm:$false | Out-Null
    Write-Host "  [OK] removed existing task"
}

# ---------------------------------------------------------------------------
# 5. Register the new task.
#
#    Action:  powershell.exe -WindowStyle Hidden ... -File <wrapper>
#    Trigger: every 5 minutes, indefinitely, starting now
#    Principal: current user, interactive token (REQUIRED for DPAPI auth)
#    Settings: hidden, hard 10-minute kill, allow start on demand,
#              ignore new instances if previous still running
# ---------------------------------------------------------------------------
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WrapperScript`"" `
    -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew `
    -RestartCount 0

$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'TaskPilot ambient deliberation auto-drain (5-minute cadence)'

try {
    Register-ScheduledTask -TaskName $TaskLeaf -TaskPath "$TaskFolder\" -InputObject $task | Out-Null
} catch {
    Write-Host ""
    Write-Host "  [FAIL] Register-ScheduledTask threw: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  [OK] Registered scheduled task $TaskName" -ForegroundColor Green
Write-Host ""
Write-Host "  Cadence: every 5 minutes (only while $($env:USERNAME) is logged on and awake)"
Write-Host "  Logs:    $LogPath"
Write-Host "  Disable: .\scripts\teardown-auto-drain.ps1"
Write-Host ""
Write-Host "  Note: the task uses your existing Claude Code login (no API key)."
Write-Host "  If 'claude /login' expires, fires will fail silently - check the log."
Write-Host ""
exit 0
