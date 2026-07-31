# run-ambient-deliberate.ps1
#
# Invoked by the Windows Task Scheduler entry "TaskPilot Ambient Deliberate"
# every 5 minutes (see scripts/setup-auto-drain.ps1).
#
# Drains pending deliberation requests in ~/.taskpilot/io/deliberate/ by
# spawning the locally installed Claude Code CLI in headless mode (`-p`).
# Auth is read from the user's Windows Credential Manager (DPAPI) -- no
# API key is set or read by this script. That's why the scheduled task
# MUST run as the logged-on interactive user (`<LogonType>InteractiveToken</LogonType>`).
#
# What this script does on each fire:
#   1. Resolves the newest installed claude.exe under
#      %APPDATA%\Claude\claude-code\<version>\. Claude Desktop self-updates,
#      so we never hardcode a version path.
#   2. Short-circuits when the deliberation queue is empty (saves Agent SDK
#      credits -- billing on those starts June 15 2026).
#   3. Spawns claude.exe with the supported headless flags:
#        -p                       non-interactive, prompt-to-stdout
#        --permission-mode bypassPermissions
#        --output-format json     machine-parseable result envelope
#        --no-session-persistence so /resume doesn't fill with cron noise
#        --add-dir ~/.taskpilot/io   so the skill can read the queue dir
#      The prompt uses language from the ambient-deliberate skill's own
#      `description` field so SkillRule autoloads the skill in -p mode
#      (the `/ambient-deliberate` slash-command form does NOT work outside
#      interactive mode -- see docs).
#   4. Streams stdout/stderr to ~/.taskpilot/logs/auto-drain.log with a
#      5 MB cap (rotates to .1 on overflow).
#
# Exit codes:
#   0 -- drain completed cleanly OR queue empty (no-op)
#   1 -- claude.exe not found
#   non-zero pass-through from claude.exe on its own failures

$ErrorActionPreference = 'Stop'
$start = Get-Date

# ---------------------------------------------------------------------------
# Resolve newest claude.exe under %APPDATA%\Claude\claude-code\<semver>\.
# Claude Desktop installs every update side-by-side and leaves the old dirs
# in place, so we must pick the highest semver each fire.
# ---------------------------------------------------------------------------
$claudeRoot = Join-Path $env:APPDATA 'Claude\claude-code'
if (-not (Test-Path $claudeRoot)) {
    Write-Error "Claude Code install root not found at $claudeRoot. Install Claude Code Desktop and run `claude /login`."
    exit 1
}

$newest = Get-ChildItem -Path $claudeRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object -Property @{ Expression = { [version]$_.Name } } -Descending |
    Select-Object -First 1

if (-not $newest) {
    Write-Error "No versioned claude.exe directory under $claudeRoot."
    exit 1
}

$claude = Join-Path $newest.FullName 'claude.exe'
if (-not (Test-Path $claude)) {
    Write-Error "Resolved $($newest.FullName) but claude.exe missing inside it."
    exit 1
}

# ---------------------------------------------------------------------------
# Log path + rotation (cap at 5 MB).
# ---------------------------------------------------------------------------
$logDir = Join-Path $env:USERPROFILE '.taskpilot\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'auto-drain.log'

if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
    Move-Item -Path $log -Destination "$log.1" -Force -ErrorAction SilentlyContinue
}

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f $start.ToString('s'), $Message
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# ---------------------------------------------------------------------------
# Queue-empty short-circuit.
# ---------------------------------------------------------------------------
$queueDir = Join-Path $env:USERPROFILE '.taskpilot\io\deliberate'
if (-not (Test-Path $queueDir)) {
    Write-Log "queue dir missing ($queueDir), skipping"
    exit 0
}

$pending = Get-ChildItem -Path $queueDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -eq '.json' }

if (-not $pending -or $pending.Count -eq 0) {
    Write-Log "queue empty, skipping"
    exit 0
}

Write-Log "firing claude $($newest.Name) on $($pending.Count) pending item(s)"

# ---------------------------------------------------------------------------
# Spawn claude.exe headless. The prompt MUST echo language from the
# ambient-deliberate skill's description so SkillRule autoloads it in -p
# mode (per Anthropic docs, /<skill> slash-commands are interactive-only).
# ---------------------------------------------------------------------------
$prompt = @'
Process pending deliberations from the TaskPilot deliberation queue at ~/.taskpilot/io/deliberate/.
Drain the deliberation queue using the ambient-deliberate skill -- score the deliberation batch and exit cleanly when the queue is empty.
This is the ambient watch / auto-drain pass: do not engage in conversation, do not ask questions, run the skill end-to-end and stop.
'@

$ioPath = Join-Path $env:USERPROFILE '.taskpilot\io'

try {
    & $claude -p $prompt `
        --permission-mode bypassPermissions `
        --output-format json `
        --no-session-persistence `
        --add-dir $ioPath `
        *>> $log
    $code = $LASTEXITCODE
} catch {
    Write-Log "exception: $_"
    exit 2
}

$elapsed = [int]((Get-Date) - $start).TotalSeconds
Write-Log "done (exit=$code, elapsed=${elapsed}s)"
exit $code
