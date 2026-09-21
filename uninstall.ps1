# Uninstalls the gateway and the skill. NEVER deletes .env, usage.jsonl, or
# agent-runs.jsonl -- if you want to delete them, do it by hand.
# If the gateway is running, it kills it first (otherwise it would leave an
# orphaned process with no one managing it).

$ErrorActionPreference = "Stop"
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$GatewayDst = Join-Path $ClaudeHome "deepseek-gateway"
$SkillDst   = Join-Path $ClaudeHome "skills\claudeseek"
$OldSkillDst = Join-Path $ClaudeHome "skills\mascota-deepseek"

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4319/health" -TimeoutSec 1 -ErrorAction Stop
    if ($health.pid) {
        Write-Host "Stopping gateway (pid $($health.pid))..."
        Stop-Process -Id $health.pid -Force -ErrorAction SilentlyContinue
    }
} catch { }

$codeFiles = @(
  "deepseek-client.mjs", "translate.mjs", "server.mjs", "start.mjs", "cli.mjs", "scoped-env.mjs",
  "deepseek-agent.mjs", "deepseek-session.mjs", "deepseek-session.cmd", "deepseek-session",
  "dsk.cmd", "dsk", "config.json", "prices.json"
)
foreach ($f in $codeFiles) {
    $p = Join-Path $GatewayDst $f
    if (Test-Path $p) { Remove-Item -Force $p; Write-Host "Deleted: $p" }
}
Write-Host "Kept (on purpose): .env, usage.jsonl, agent-runs.jsonl, gateway.log in $GatewayDst"

foreach ($d in @($SkillDst, $OldSkillDst)) {
    if (Test-Path $d) {
        Remove-Item -Recurse -Force $d
        Write-Host "Deleted: $d"
    }
}

$LocalBin = Join-Path $env:USERPROFILE ".local\bin"
foreach ($f in @("deepseek.cmd", "deepseek")) {
    $p = Join-Path $LocalBin $f
    if (Test-Path $p) { Remove-Item -Force $p; Write-Host "Deleted: $p" }
}
