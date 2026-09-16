# Instala el gateway DeepSeek <-> Claude Code y la skill que le enseña a
# Claude Code cuándo y cómo delegar.
#
# NO toca settings.json ni ninguna variable ANTHROPIC_* global: el gateway
# solo se usa cuando algo lo invoca explícitamente (delegación headless o
# sesión interactiva dedicada). Tu sesión normal de Claude Code queda 100%
# intacta, siempre.
#
# Seguro de correr varias veces: nunca toca .env ni los logs si ya existen.

$ErrorActionPreference = "Stop"

$RepoRoot   = $PSScriptRoot
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"

$GatewaySrc = Join-Path $RepoRoot "gateway"
$GatewayDst = Join-Path $ClaudeHome "deepseek-gateway"

$SkillSrc   = Join-Path $RepoRoot "claudeseek"
$SkillDst   = Join-Path $ClaudeHome "skills\claudeseek"

Write-Host "Instalando gateway en $GatewayDst ..."
New-Item -ItemType Directory -Force -Path $GatewayDst | Out-Null
$codeFiles = @(
  "deepseek-client.mjs", "translate.mjs", "server.mjs", "start.mjs", "cli.mjs", "scoped-env.mjs",
  "deepseek-agent.mjs", "deepseek-session.mjs", "deepseek-session.cmd", "deepseek-session",
  "dsk.cmd", "dsk", "config.json", "prices.json"
)
foreach ($f in $codeFiles) {
    Copy-Item -Path (Join-Path $GatewaySrc $f) -Destination (Join-Path $GatewayDst $f) -Force
}

$EnvPath = Join-Path $GatewayDst ".env"
if (-not (Test-Path $EnvPath)) {
    Write-Host "Creando $EnvPath con placeholder (no existía)..."
    @"
# Pegá acá tu API key de DeepSeek (https://platform.deepseek.com/api_keys).
# Una sola línea, sin comillas. Este archivo nunca se sube a git ni se pisa
# al reinstalar.
DEEPSEEK_API_KEY=PEGA_TU_API_KEY_AQUI
"@ | Out-File -FilePath $EnvPath -Encoding utf8 -NoNewline
} else {
    Write-Host "$EnvPath ya existe, no se toca."
}

Write-Host "Instalando skill claudeseek en $SkillDst ..."
if (Test-Path $SkillDst) { Remove-Item -Recurse -Force $SkillDst }
Copy-Item -Recurse -Path $SkillSrc -Destination $SkillDst -Force

# Migración: hasta la v0.2 la skill se llamaba "mascota-deepseek". Si quedó
# instalada, se saca para que Claude Code no vea dos skills iguales.
$OldSkillDst = Join-Path $ClaudeHome "skills\mascota-deepseek"
if (Test-Path $OldSkillDst) {
    Remove-Item -Recurse -Force $OldSkillDst
    Write-Host "Skill vieja 'mascota-deepseek' eliminada (ahora se llama 'claudeseek')."
}

$LocalBin = Join-Path $env:USERPROFILE ".local\bin"
if (Test-Path $LocalBin) {
    Write-Host "Instalando comando corto 'deepseek' en $LocalBin ..."
    Copy-Item -Path (Join-Path $RepoRoot "gateway\bin\deepseek.cmd") -Destination (Join-Path $LocalBin "deepseek.cmd") -Force
    Copy-Item -Path (Join-Path $RepoRoot "gateway\bin\deepseek") -Destination (Join-Path $LocalBin "deepseek") -Force
} else {
    Write-Warning "No existe $LocalBin, no se instaló el comando corto 'deepseek'. Usá deepseek-session.cmd directo."
}

Write-Host ""
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Warning "No se encontró 'node' en el PATH. El gateway requiere Node.js 18+." }
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { Write-Warning "No se encontró 'claude' en el PATH. La delegación headless (deepseek-agent.mjs) lo necesita." }

Write-Host "Listo. Verificación:"
Write-Host "  1) Pegá tu API key en: $EnvPath"
Write-Host "  2) Corré: node `"$GatewayDst\cli.mjs`" doctor"
Write-Host "  3) Sesión sobre DeepSeek: deepseek [--model deepseek-flash-thinking] [-c|-r] [--dangerously-skip-permissions]"
Write-Host ""
Write-Host "Nada se activó todavía: el gateway arranca solo cuando algo lo usa"
Write-Host "(delegación o sesion interactiva de DeepSeek). Tu Claude Code normal sigue igual."
