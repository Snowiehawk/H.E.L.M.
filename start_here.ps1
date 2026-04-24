$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $scriptDir "scripts\helm-launch.ps1"
& $launcher bootstrap @args
exit $LASTEXITCODE
