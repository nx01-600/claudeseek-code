# Installs the DeepSeek <-> Claude Code gateway and the skill that teaches
# Claude Code when and how to delegate.
#
# Does NOT touch settings.json or any global ANTHROPIC_* variable: the gateway
# is only used when something explicitly invokes it (headless delegation or a
# dedicated interactive session). Your normal Claude Code session stays 100%
# intact, always.
#
# Safe to run multiple times: never touches .env or the logs if they already exist.

$ErrorActionPreference = "Stop"

$RepoRoot   = $PSScriptRoot
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"

$GatewaySrc = Join-Path $RepoRoot "gateway"
$GatewayDst = Join-Path $ClaudeHome "deepseek-gateway"

$SkillSrc   = Join-Path $RepoRoot "claudeseek"
$SkillDst   = Join-Path $ClaudeHome "skills\claudeseek"

Write-Host "Installing gateway to $GatewayDst ..."
New-Item -ItemType Directory -Force -Path $GatewayDst | Out-Null
$codeFiles = @(
  "deepseek-client.mjs", "translate.mjs", "server.mjs", "start.mjs", "cli.mjs", "scoped-env.mjs",
  "deepseek-agent.mjs", "deepseek-session.mjs", "deepseek-session.cmd", "deepseek-session",
  "escalate-to-sonnet.mjs", "dsk.cmd", "dsk", "config.json", "prices.json"
)
foreach ($f in $codeFiles) {
    Copy-Item -Path (Join-Path $GatewaySrc $f) -Destination (Join-Path $GatewayDst $f) -Force
}

$EnvPath = Join-Path $GatewayDst ".env"
if (-not (Test-Path $EnvPath)) {
    Write-Host "Creating $EnvPath with a placeholder (it didn't exist)..."
    @"
# Paste your DeepSeek API key here (https://platform.deepseek.com/api_keys).
# A single line, no quotes. This file is never pushed to git and never
# overwritten on reinstall.
DEEPSEEK_API_KEY=PASTE_YOUR_API_KEY_HERE
"@ | Out-File -FilePath $EnvPath -Encoding utf8 -NoNewline
} else {
    Write-Host "$EnvPath already exists, leaving it alone."
}

Write-Host "Installing the claudeseek skill to $SkillDst ..."
if (Test-Path $SkillDst) { Remove-Item -Recurse -Force $SkillDst }
Copy-Item -Recurse -Path $SkillSrc -Destination $SkillDst -Force

# Migration: up through v0.2 the skill was named "mascota-deepseek". If it's
# still installed, remove it so Claude Code doesn't see two identical skills.
$OldSkillDst = Join-Path $ClaudeHome "skills\mascota-deepseek"
if (Test-Path $OldSkillDst) {
    Remove-Item -Recurse -Force $OldSkillDst
    Write-Host "Old 'mascota-deepseek' skill removed (now called 'claudeseek')."
}

$LocalBin = Join-Path $env:USERPROFILE ".local\bin"
if (Test-Path $LocalBin) {
    Write-Host "Installing the short 'deepseek' command to $LocalBin ..."
    Copy-Item -Path (Join-Path $RepoRoot "gateway\bin\deepseek.cmd") -Destination (Join-Path $LocalBin "deepseek.cmd") -Force
    Copy-Item -Path (Join-Path $RepoRoot "gateway\bin\deepseek") -Destination (Join-Path $LocalBin "deepseek") -Force
} else {
    Write-Warning "$LocalBin doesn't exist, the short 'deepseek' command wasn't installed. Use deepseek-session.cmd directly."
}

Write-Host ""
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Warning "Could not find 'node' in PATH. The gateway requires Node.js 18+." }
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { Write-Warning "Could not find 'claude' in PATH. Headless delegation (deepseek-agent.mjs) needs it." }

Write-Host "Done. Verification:"
Write-Host "  1) Paste your API key into: $EnvPath"
Write-Host "  2) Run: node `"$GatewayDst\cli.mjs`" doctor"
Write-Host "  3) Session on DeepSeek: deepseek [--model deepseek-flash-thinking] [-c|-r] [--dangerously-skip-permissions]"
Write-Host ""
Write-Host "Nothing was activated yet: the gateway only starts when something uses it"
Write-Host "(delegation or an interactive DeepSeek session). Your normal Claude Code stays the same."
