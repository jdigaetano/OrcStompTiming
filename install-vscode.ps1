#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs VS Code and replicates Tony's dev environment.
    Run from an elevated PowerShell prompt.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg) Write-Host "    OK: $msg" -ForegroundColor Green }

# ─── 1. Install VS Code via winget ───────────────────────────────────────────
Write-Step "Installing Visual Studio Code"
$installed = winget list --id Microsoft.VisualStudioCode 2>$null | Select-String 'Microsoft.VisualStudioCode'
if ($installed) {
    Write-OK "VS Code already installed — skipping"
} else {
    winget install --id Microsoft.VisualStudioCode --silent --accept-package-agreements --accept-source-agreements
    Write-OK "VS Code installed"
}

# Ensure 'code' CLI is on PATH for this session
$codePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin"
if (Test-Path $codePath) {
    $env:PATH = "$codePath;$env:PATH"
}

# ─── 2. Install Fira Code font ───────────────────────────────────────────────
Write-Step "Installing Fira Code font"
$fontCheck = Get-ChildItem "C:\Windows\Fonts" -Filter "FiraCode*" -ErrorAction SilentlyContinue
if ($fontCheck) {
    Write-OK "Fira Code already installed"
} else {
    $tmpDir  = "$env:TEMP\FiraCode"
    $zipFile = "$tmpDir\FiraCode.zip"
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

    Write-Host "    Downloading Fira Code..."
    $releaseUrl = "https://github.com/tonsky/FiraCode/releases/download/6.2/Fira_Code_v6.2.zip"
    Invoke-WebRequest -Uri $releaseUrl -OutFile $zipFile -UseBasicParsing
    Expand-Archive -Path $zipFile -DestinationPath $tmpDir -Force

    $fonts     = Get-ChildItem "$tmpDir\ttf" -Filter "*.ttf"
    $fontsDir  = (New-Object -ComObject Shell.Application).Namespace(0x14)
    foreach ($font in $fonts) {
        if (-not (Test-Path "C:\Windows\Fonts\$($font.Name)")) {
            $fontsDir.CopyHere($font.FullName, 0x10)
        }
    }
    Remove-Item $tmpDir -Recurse -Force
    Write-OK "Fira Code installed"
}

# ─── 3. Install extensions ───────────────────────────────────────────────────
Write-Step "Installing VS Code extensions"
$extensions = @(
    "anthropic.claude-code",
    "mccarter.start-git-bash"
)
foreach ($ext in $extensions) {
    Write-Host "    Installing $ext ..."
    code --install-extension $ext --force
}
Write-OK "Extensions installed"

# ─── 4. Write user settings ──────────────────────────────────────────────────
Write-Step "Writing VS Code user settings"
$settingsDir = "$env:APPDATA\Code\User"
New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null

$settings = @'
{
    "workbench.colorTheme": "Winter is Coming (Dark Black)",
    "editor.fontFamily": "Fira Code",
    "editor.fontLigatures": true,
    "editor.fontWeight": null,
    "terminal.integrated.initialHint": false,
    "claudeCode.preferredLocation": "panel",
    "terminal.integrated.profiles.windows": {
        "PowerShell": {
            "source": "PowerShell",
            "icon": "terminal-powershell"
        },
        "Command Prompt": {
            "path": [
                "${env:windir}\\Sysnative\\cmd.exe",
                "${env:windir}\\System32\\cmd.exe"
            ],
            "args": [],
            "icon": "terminal-cmd"
        },
        "Git Bash": {
            "path": "c:\\program files\\Git\\bin\\bash.exe",
            "args": ["--login", "-i"]
        }
    },
    "terminal.integrated.defaultProfile.windows": "Git Bash",
    "git.autofetch": true
}
'@

Set-Content -Path "$settingsDir\settings.json" -Value $settings -Encoding utf8
Write-OK "settings.json written"

# ─── Done ────────────────────────────────────────────────────────────────────
Write-Host "`nDone. Restart VS Code to pick up the new theme and font." -ForegroundColor Yellow
Write-Host "If 'Winter is Coming' theme is missing, it will show as the default theme until the extension installs on first launch." -ForegroundColor DarkYellow
