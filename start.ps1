# Musiclab one-click launcher for Windows. Double-click start.bat to run this.
Set-Location $PSScriptRoot

# Step 1: find Visual Studio's C compiler (cl). Needs "Desktop development with C++" or C++ Build Tools.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if (-not $vs) { Read-Host 'Visual Studio C++ Build Tools not found. Install them, then retry. Press Enter'; exit 1 }

# Step 2: compile the three C files into build\musiclab.exe
# /STACK: 8 MB like Linux; Windows' 1 MB default is too small for the playlist state kept on the stack
Write-Host 'Building...'
New-Item -ItemType Directory -Force build | Out-Null
cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cl /nologo /std:c11 /O2 /W3 /wd5105 /D_CRT_SECURE_NO_WARNINGS /D_CRT_NONSTDC_NO_WARNINGS /Isrc src\server.c src\api.c src\playlist.c /Fobuild\ /Febuild\musiclab.exe /link /STACK:8388608"
if ($LASTEXITCODE -ne 0) { Read-Host 'Build failed. Press Enter'; exit 1 }

# Step 3: ask Windows for a free port (port 0 means "any free port")
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start(); $port = $probe.LocalEndpoint.Port; $probe.Stop()

# Step 4: start the server in its own window (close that window to stop it)
Start-Process build\musiclab.exe -ArgumentList '--port', $port -WorkingDirectory $PSScriptRoot

# Step 5: wait until the server answers, then open the browser
# 127.0.0.1, not localhost: the server listens on IPv4 only, some browsers try IPv6 for localhost
$url = "http://127.0.0.1:$port/"
Write-Host "Waiting for $url ..."
foreach ($try in 1..20) {
    try {
        Invoke-WebRequest $url -UseBasicParsing | Out-Null
        Start-Process $url
        Write-Host "Running at $url"
        exit 0
    } catch { Start-Sleep 1 }
}
Read-Host 'Server did not start. Check the server window. Press Enter'
exit 1
