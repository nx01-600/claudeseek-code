# Desinstala el gateway y la skill. NUNCA borra .env, usage.jsonl ni
# agent-runs.jsonl -- si querés borrarlos, hacelo a mano.
# Si el gateway está corriendo, lo mata primero (si no, quedaría un proceso
# huérfano sin nadie que lo administre).

$ErrorActionPreference = "Stop"
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$GatewayDst = Join-Path $ClaudeHome "deepseek-gateway"
$SkillDst   = Join-Path $ClaudeHome "skills\claudeseek"
$OldSkillDst = Join-Path $ClaudeHome "skills\mascota-deepseek"

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4319/health" -TimeoutSec 1 -ErrorAction Stop
    if ($health.pid) {
        Write-Host "Deteniendo gateway (pid $($health.pid))..."
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
    if (Test-Path $p) { Remove-Item -Force $p; Write-Host "Borrado: $p" }
}
Write-Host "Se conservan (a propósito): .env, usage.jsonl, agent-runs.jsonl, gateway.log en $GatewayDst"

foreach ($d in @($SkillDst, $OldSkillDst)) {
    if (Test-Path $d) {
        Remove-Item -Recurse -Force $d
        Write-Host "Borrado: $d"
    }
}

$LocalBin = Join-Path $env:USERPROFILE ".local\bin"
foreach ($f in @("deepseek.cmd", "deepseek")) {
    $p = Join-Path $LocalBin $f
    if (Test-Path $p) { Remove-Item -Force $p; Write-Host "Borrado: $p" }
}
