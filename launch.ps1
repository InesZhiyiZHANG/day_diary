$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$url = 'http://127.0.0.1:8765/'
$statusUrl = 'http://127.0.0.1:8765/api/status'

function Show-LaunchError([string]$message) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($message, '莓好日常启动失败', 'OK', 'Error') | Out-Null
}

try {
    $ready = $false
    try {
        $null = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 2
        $ready = $true
    } catch { }

    if (-not $ready) {
        $venvPython = Join-Path $appDir '..\.venv\Scripts\python.exe'
        if (Test-Path -LiteralPath $venvPython) {
            $python = (Resolve-Path -LiteralPath $venvPython).Path
            $pythonArgs = @('server.py')
        } else {
            $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
            if ($pythonCommand) {
                $python = $pythonCommand.Source
                $pythonArgs = @('server.py')
            } else {
                $pyCommand = Get-Command py.exe -ErrorAction SilentlyContinue
                if (-not $pyCommand) {
                    throw '没有找到 Python 3。请安装 Python 3.10 或更高版本后重试。'
                }
                $python = $pyCommand.Source
                $pythonArgs = @('-3', 'server.py')
            }
        }

        $dataDir = Join-Path $appDir 'data'
        $null = New-Item -ItemType Directory -Path $dataDir -Force
        $stdout = Join-Path $dataDir 'server.log'
        $stderr = Join-Path $dataDir 'server-error.log'
        $null = Start-Process -FilePath $python -ArgumentList $pythonArgs -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            Start-Sleep -Milliseconds 250
            try {
                $null = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 1
                $ready = $true
                break
            } catch { }
        }

        if (-not $ready) {
            $details = ''
            if (Test-Path -LiteralPath $stderr) {
                $details = (Get-Content -LiteralPath $stderr -Tail 12 -ErrorAction SilentlyContinue) -join "`n"
            }
            if (-not $details) { $details = '请确认已安装 Python 3.10 或更高版本，并检查 8765 端口是否被占用。' }
            throw "本地服务没有启动。`n`n$details`n`n日志位置：$stderr"
        }
    }

    Start-Process $url
} catch {
    Show-LaunchError $_.Exception.Message
    exit 1
}

