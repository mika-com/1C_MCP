# db-install-agentquery — загрузить расширение AgentQuery.
# Реализация одна: scripts/db-install-agentquery.py (подготовка XML и вызов db-load-xml).
# Пароль в параметры не входит. Точка входа .ps1 нужна агенту на Windows, как у остальных навыков.
param(
    [string]$Database = '',
    [string]$InfoBasePath = '',
    [string]$InfoBaseServer = '',
    [string]$InfoBaseRef = '',
    [string]$ConfigPath = '',
    [string]$V8Path = '',
    [string]$OutputDir = '',
    [switch]$NoUpdate,
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$py = $null
foreach ($name in @('python', 'python3', 'py')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
}
if (-not $py) {
    Write-Host 'Error: для db-install-agentquery нужен Python (python или py). Пароль в команду не подставляйте.' -ForegroundColor Red
    exit 1
}

$script = Join-Path $PSScriptRoot 'db-install-agentquery.py'
$pyArgs = @($script)
if ($Database) { $pyArgs += @('-Database', $Database) }
if ($InfoBasePath) { $pyArgs += @('-InfoBasePath', $InfoBasePath) }
if ($InfoBaseServer) { $pyArgs += @('-InfoBaseServer', $InfoBaseServer) }
if ($InfoBaseRef) { $pyArgs += @('-InfoBaseRef', $InfoBaseRef) }
if ($ConfigPath) { $pyArgs += @('-ConfigPath', $ConfigPath) }
if ($V8Path) { $pyArgs += @('-V8Path', $V8Path) }
if ($OutputDir) { $pyArgs += @('-OutputDir', $OutputDir) }
if ($NoUpdate) { $pyArgs += '-NoUpdate' }
if ($PrepareOnly) { $pyArgs += '-PrepareOnly' }

& $py @pyArgs
exit $LASTEXITCODE
