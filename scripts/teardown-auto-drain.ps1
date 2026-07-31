# teardown-auto-drain.ps1
#
# Removes the Windows scheduled task "TaskPilot\AmbientDeliberate"
# registered by setup-auto-drain.ps1.
#
# Safe to run if the task isn't registered (idempotent -- exits 0 with
# a message).
#
# Usage:
#   .\scripts\teardown-auto-drain.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$TaskFolder = '\TaskPilot'
$TaskLeaf   = 'AmbientDeliberate'

Write-Host ""
Write-Host "TaskPilot auto-drain teardown" -ForegroundColor Cyan
Write-Host "============================="
Write-Host ""

$existing = Get-ScheduledTask -TaskName $TaskLeaf -TaskPath "$TaskFolder\" -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "  No registered task at $TaskFolder\$TaskLeaf. Nothing to do." -ForegroundColor Yellow
    exit 0
}

try {
    Unregister-ScheduledTask -TaskName $TaskLeaf -TaskPath "$TaskFolder\" -Confirm:$false | Out-Null
    Write-Host "  [OK] removed $TaskFolder\$TaskLeaf" -ForegroundColor Green
} catch {
    Write-Host "  [FAIL] Unregister-ScheduledTask threw: $_" -ForegroundColor Red
    exit 1
}

# Best-effort: prune the TaskPilot folder if it's now empty so we don't
# leave an orphan node in Task Scheduler.
try {
    $remaining = Get-ScheduledTask -TaskPath "$TaskFolder\" -ErrorAction SilentlyContinue
    if (-not $remaining) {
        $sched = New-Object -ComObject 'Schedule.Service'
        $sched.Connect()
        $root = $sched.GetFolder('\')
        try {
            $root.DeleteFolder('TaskPilot', 0)
            Write-Host "  [OK] removed empty TaskPilot folder"
        } catch {
            # folder may not actually be empty (other TaskPilot tasks),
            # or the API may not be available. Non-fatal.
        }
    }
} catch {
    # Non-fatal.
}

Write-Host ""
exit 0
