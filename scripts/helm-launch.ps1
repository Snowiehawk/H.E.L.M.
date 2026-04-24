$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$devEntrypoint = Join-Path $PSScriptRoot "dev.py"
$windowsDesktopWorkloadId = "Microsoft.VisualStudio.Workload.VCTools"
$windowsDesktopCompilerComponentId = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"

function Write-HelmStep {
    param([string]$Message)
    Write-Host "[helm launcher] $Message"
}

function Get-HelmProfile {
    param([string[]]$CliArgs)

    if ($CliArgs.Length -eq 0) {
        return "python"
    }

    if ($CliArgs | Where-Object { $_ -in @("-h", "--help", "help") }) {
        return "python"
    }

    switch ($CliArgs[0]) {
        "scan" { return "python" }
        "ui" { return "ui" }
        "desktop" { return "desktop" }
        "bootstrap" {
            if ($CliArgs -contains "--python-only") {
                return "python"
            }
            if ($CliArgs -contains "--ui-only") {
                return "ui"
            }
            return "desktop"
        }
        default { return "python" }
    }
}

function Refresh-PathFromEnvironment {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathSegments = @()
    if ($machinePath) {
        $pathSegments += $machinePath
    }
    if ($userPath) {
        $pathSegments += $userPath
    }
    if ($env:Path) {
        $pathSegments += $env:Path
    }
    $env:Path = ($pathSegments | Where-Object { $_ } | Select-Object -Unique) -join ";"
}

function Test-UsablePython {
    param(
        [string]$Executable,
        [string[]]$PrefixArgs = @()
    )

    try {
        & $Executable @PrefixArgs -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function New-PythonLauncher {
    param(
        [string]$Executable,
        [string[]]$PrefixArgs = @()
    )

    return [pscustomobject]@{
        Executable = $Executable
        PrefixArgs = $PrefixArgs
    }
}

function Find-PythonLauncher {
    $override = $env:HELM_BOOTSTRAP_PYTHON_BIN
    if ($override -and (Test-Path $override) -and (Test-UsablePython -Executable $override)) {
        return New-PythonLauncher -Executable $override
    }

    if (Test-UsablePython -Executable "py" -PrefixArgs @("-3")) {
        return New-PythonLauncher -Executable "py" -PrefixArgs @("-3")
    }

    if (Test-UsablePython -Executable "python") {
        return New-PythonLauncher -Executable "python"
    }

    return $null
}

function Find-PythonManagerExecutable {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return "py"
    }

    $windowsAppsDir = Join-Path $env:LocalAppData "Microsoft\WindowsApps"
    try {
        if (Test-Path $windowsAppsDir -ErrorAction Stop) {
            $candidate = Get-ChildItem -Path $windowsAppsDir -Filter py.exe -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($candidate) {
                return $candidate.FullName
            }
        }
    } catch {
        return $null
    }

    return $null
}

function Invoke-WingetInstall {
    param(
        [string]$Id,
        [string]$DisplayName,
        [string[]]$AdditionalArgs = @()
    )

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Missing `winget`, so HELM cannot auto-install $DisplayName on Windows."
    }

    Write-HelmStep "Installing $DisplayName with winget."
    & winget install --id $Id -e --accept-package-agreements --accept-source-agreements --disable-interactivity @AdditionalArgs
    if ($LASTEXITCODE -ne 0) {
        throw "winget failed while installing $DisplayName."
    }
    Refresh-PathFromEnvironment
}

function Convert-ToWindowsCommandLine {
    param([string[]]$ArgumentList)

    $encoded = foreach ($argument in $ArgumentList) {
        if ($argument -match '[\s"]') {
            '"' + ($argument -replace '"', '\"') + '"'
            continue
        }
        $argument
    }

    return ($encoded -join " ")
}

function Test-WindowsProcessIsElevated {
    try {
        $groups = & whoami /groups 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
        return ($groups -match "S-1-16-12288") -or ($groups -match "S-1-16-16384")
    } catch {
        return $false
    }
}

function Invoke-WindowsProcess {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$DisplayName,
        [switch]$RequireElevation
    )

    Write-HelmStep "$DisplayName."
    $startProcessArgs = @{
        FilePath = $FilePath
        ArgumentList = (Convert-ToWindowsCommandLine -ArgumentList $ArgumentList)
        Wait = $true
        PassThru = $true
    }
    if ($RequireElevation -and -not (Test-WindowsProcessIsElevated)) {
        Write-HelmStep "Windows may show a UAC prompt to continue."
        $startProcessArgs["Verb"] = "RunAs"
    }

    $process = Start-Process @startProcessArgs
    if ($process.ExitCode -notin @(0, 3010)) {
        throw "$DisplayName failed with exit code $($process.ExitCode)."
    }
}

function Ensure-WindowsPython {
    $launcher = Find-PythonLauncher
    if ($launcher) {
        return $launcher
    }

    $pythonManager = Find-PythonManagerExecutable
    if (-not $pythonManager) {
        Invoke-WingetInstall -Id "9NQ7512CXL7T" -DisplayName "Python install manager"
        $pythonManager = Find-PythonManagerExecutable
        if (-not $pythonManager) {
            throw "Python install manager was installed, but the `py` command is still unavailable."
        }
    }

    Write-HelmStep "Installing the default managed Python runtime."
    & $pythonManager install default
    if ($LASTEXITCODE -ne 0) {
        throw "Python install manager could not install the default runtime."
    }

    $launcher = Find-PythonLauncher
    if (-not $launcher) {
        throw "Python was installed, but HELM still cannot find a usable Python 3.9+ runtime."
    }
    return $launcher
}

function Test-CommandWorks {
    param(
        [string]$CommandName,
        [string[]]$VersionArgs = @("--version")
    )

    try {
        & $CommandName @VersionArgs *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Get-UserCargoBinPath {
    return Join-Path $env:USERPROFILE ".cargo\bin"
}

function Add-UserCargoBinToPath {
    $cargoBin = Get-UserCargoBinPath
    if (-not (Test-Path $cargoBin)) {
        return
    }

    $segments = @($env:Path -split ";") | Where-Object { $_ }
    if ($segments -contains $cargoBin) {
        return
    }
    $env:Path = "$cargoBin;$env:Path"
}

function Find-RustupExecutable {
    $command = Get-Command rustup -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidate = Join-Path (Get-UserCargoBinPath) "rustup.exe"
    if (Test-Path $candidate) {
        return $candidate
    }

    return $null
}

function Get-WindowsNodeBinPath {
    $candidates = @(
        (Join-Path $env:ProgramFiles "nodejs"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs")
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if ((Test-Path (Join-Path $candidate "node.exe")) -and (Test-Path (Join-Path $candidate "npm.cmd"))) {
            return $candidate
        }
    }

    return $null
}

function Add-WindowsNodeBinToPath {
    $nodeBin = Get-WindowsNodeBinPath
    if (-not $nodeBin) {
        return
    }

    $segments = @($env:Path -split ";") | Where-Object { $_ }
    if ($segments -contains $nodeBin) {
        return
    }
    $env:Path = "$nodeBin;$env:Path"
}

function Initialize-WindowsRustToolchain {
    $rustupExecutable = Find-RustupExecutable
    if (-not $rustupExecutable) {
        return $false
    }

    Add-UserCargoBinToPath
    Write-HelmStep "Configuring the existing Rustup install."
    & $rustupExecutable default stable-msvc
    if ($LASTEXITCODE -ne 0) {
        throw "Rustup is installed, but HELM could not initialize the stable MSVC toolchain."
    }

    Refresh-PathFromEnvironment
    Add-UserCargoBinToPath
    return Test-CommandWorks -CommandName "cargo" -VersionArgs @("--version")
}

function Ensure-WindowsNode {
    Add-WindowsNodeBinToPath
    if ((Test-CommandWorks -CommandName "node" -VersionArgs @("--version")) -and
        (Test-CommandWorks -CommandName "npm" -VersionArgs @("--version"))) {
        return
    }

    Invoke-WingetInstall -Id "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS"
    Add-WindowsNodeBinToPath
    if (-not ((Test-CommandWorks -CommandName "node" -VersionArgs @("--version")) -and
        (Test-CommandWorks -CommandName "npm" -VersionArgs @("--version")))) {
        throw "Node.js was installed, but `node` and `npm` are still unavailable in this shell."
    }
}

function Ensure-WindowsRust {
    Add-UserCargoBinToPath
    if (Test-CommandWorks -CommandName "cargo" -VersionArgs @("--version")) {
        return
    }

    if (Initialize-WindowsRustToolchain) {
        return
    }

    Invoke-WingetInstall -Id "Rustlang.Rustup" -DisplayName "Rustup"
    if (Initialize-WindowsRustToolchain) {
        return
    }
    throw "Rust was installed, but `cargo` is still unavailable in this shell."
}

function Get-WindowsDesktopToolchainInstance {
    $vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswherePath)) {
        return $null
    }

    $raw = & $vswherePath -latest -products * -requires $windowsDesktopCompilerComponentId -format json
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }

    $instances = $raw | ConvertFrom-Json
    if ($instances -isnot [System.Collections.IEnumerable]) {
        $instances = @($instances)
    }
    return $instances | Select-Object -First 1
}

function Test-WindowsDesktopBuildTools {
    $instance = Get-WindowsDesktopToolchainInstance
    if (-not $instance) {
        return $false
    }

    $clPath = Join-Path $instance.installationPath "VC\Tools\MSVC"
    if (Test-Path $clPath) {
        $compiler = Get-ChildItem $clPath -Recurse -Filter cl.exe -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($compiler) {
            return $true
        }
    }

    return $false
}

function Get-WindowsBuildToolsInstance {
    $vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswherePath)) {
        return $null
    }

    $raw = & $vswherePath -latest -products Microsoft.VisualStudio.Product.BuildTools -format json
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }

    $instances = $raw | ConvertFrom-Json
    if ($instances -isnot [System.Collections.IEnumerable]) {
        $instances = @($instances)
    }
    return $instances | Select-Object -First 1
}

function Ensure-WindowsDesktopWorkloadOnExistingBuildTools {
    $instance = Get-WindowsBuildToolsInstance
    if (-not $instance) {
        return $false
    }

    $setupPath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\setup.exe"
    if (-not (Test-Path $setupPath)) {
        return $false
    }

    $arguments = @(
        "modify",
        "--installPath", $instance.installationPath,
        "--channelId", $instance.channelId,
        "--productId", $instance.productId,
        "--add", $windowsDesktopWorkloadId,
        "--includeRecommended",
        "--passive",
        "--norestart"
    )

    Invoke-WindowsProcess `
        -FilePath $setupPath `
        -ArgumentList $arguments `
        -DisplayName "Adding the Desktop development with C++ workload to the existing Visual Studio Build Tools install" `
        -RequireElevation

    for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
        if (Test-WindowsDesktopBuildTools) {
            return $true
        }
        Start-Sleep -Seconds 5
    }

    return $false
}

function Ensure-WindowsDesktopBuildTools {
    if (Test-WindowsDesktopBuildTools) {
        return
    }

    if (Get-WindowsBuildToolsInstance) {
        if (Ensure-WindowsDesktopWorkloadOnExistingBuildTools) {
            return
        }
        throw "Visual Studio Build Tools are installed, but HELM could not add the Desktop development with C++ workload."
    }

    Invoke-WingetInstall `
        -Id "Microsoft.VisualStudio.2022.BuildTools" `
        -DisplayName "Visual Studio Build Tools (Desktop development with C++)" `
        -AdditionalArgs @(
            "--override",
            "--wait --passive --add $windowsDesktopWorkloadId --includeRecommended"
        )

    if (-not (Test-WindowsDesktopBuildTools)) {
        throw "Visual Studio Build Tools are installed, but the Desktop development with C++ workload is still unavailable."
    }
}

function Ensure-WindowsPrerequisites {
    param([string]$Profile)

    $launcher = Ensure-WindowsPython

    if ($Profile -in @("ui", "desktop")) {
        Ensure-WindowsNode
    }
    if ($Profile -eq "desktop") {
        Ensure-WindowsRust
        Ensure-WindowsDesktopBuildTools
    }

    return $launcher
}

$profile = Get-HelmProfile -CliArgs $args
$pythonLauncher = Ensure-WindowsPrerequisites -Profile $profile

Write-HelmStep "Running HELM via $($pythonLauncher.Executable)."
& $pythonLauncher.Executable @($pythonLauncher.PrefixArgs) $devEntrypoint @args
exit $LASTEXITCODE
