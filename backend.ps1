# Musiclab backend-only console. Double-click backend.bat to run this.
# Starts the C server, then sends your menu choices to it as HTTP requests (no browser).
Set-Location $PSScriptRoot
[Console]::OutputEncoding = [Text.Encoding]::UTF8   # read song titles from curl.exe as UTF-8

# Step 1: compile the three C files into build\musiclab.exe (same as start.ps1)
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if (-not $vs) { Read-Host 'Visual Studio C++ Build Tools not found. Install them, then retry. Press Enter'; exit 1 }
Write-Host 'Building...'
New-Item -ItemType Directory -Force build | Out-Null
cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cl /nologo /std:c11 /O2 /W3 /wd5105 /D_CRT_SECURE_NO_WARNINGS /D_CRT_NONSTDC_NO_WARNINGS /Isrc src\server.c src\api.c src\playlist.c /Fobuild\ /Febuild\musiclab.exe /link /STACK:8388608" | Out-Null
if ($LASTEXITCODE -ne 0) { Read-Host 'Build failed. Press Enter'; exit 1 }

# Step 2: start the server on a free port, in its own minimized window
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start(); $port = $probe.LocalEndpoint.Port; $probe.Stop()
$base = "http://127.0.0.1:$port"
$server = Start-Process build\musiclab.exe -ArgumentList '--port', $port -WorkingDirectory $PSScriptRoot -WindowStyle Minimized -PassThru

# Step 3: helpers. curl.exe, not Invoke-RestMethod: PowerShell 5.1 sends an Expect header the server rejects.
function Get-State { curl.exe -s "$base/api/state" | ConvertFrom-Json }
function Send([string]$body) { curl.exe -s "$base/api/action" -d $body | ConvertFrom-Json }
function Enc([string]$text) { [uri]::EscapeDataString($text) }
function Ptr($id) { if ($null -eq $id) { 'NULL' } else { $id } }
function Pick-List([string]$prompt = 'Playlist (A/B)') {
    if ((Read-Host $prompt) -match '^\s*[bB]') { 'secondary' } else { 'main' }
}

function Show($r, [switch]$StateOnly) {
    if ($null -eq $r) { Write-Host 'Backend not responding.' -ForegroundColor Red; return }
    if (-not $r.ok) { Write-Host "ERROR: $($r.error)" -ForegroundColor Red; return }
    if (-not $StateOnly) {
        $op = $r.operation
        Write-Host "`n$($op.action): $($op.message)   [$($op.complexity)]" -ForegroundColor Green
        $op.steps | ForEach-Object { Write-Host "  - $_" }
        # Every malloc, ID comparison, pointer write and free that playlist.c actually did
        if ($op.trace.events) { Write-Host 'C operations, in order:' -ForegroundColor Yellow }
        foreach ($e in $op.trace.events) {
            $line = switch ($e.kind) {
                'allocate' { "malloc node $($e.id) ($($e.title))" }
                'visit'    { "compare with node $($e.id)" }
                'pointer'  { $owner = if ($null -eq $e.id) { $e.playlist } else { "node $($e.id)" }
                             "$owner.$($e.field) = $(Ptr $e.to)   (was $(Ptr $e.from))" }
                'free'     { "free node $($e.id)" }
            }
            Write-Host "  $line"
        }
    }
    foreach ($p in $r.playlists) {
        $side = if ($p.id -eq 'main') { 'A' } else { 'B' }
        Write-Host "`nSide $side ($($p.id)): head=$(Ptr $p.head) tail=$(Ptr $p.tail) current=$(Ptr $p.current) size=$($p.size)" -ForegroundColor Cyan
        if (-not $p.nodes) { Write-Host '  (empty)'; continue }
        Write-Host ('  NULL <- ' + (($p.nodes | ForEach-Object { "[$($_.id)]" }) -join ' <-> ') + ' -> NULL')
        $rows = $p.nodes | ForEach-Object {
            [pscustomobject]@{ ' ' = if ($_.id -eq $p.current) { '>' } else { '' }; id = $_.id; title = $_.title
                               artist = $_.artist; prev = Ptr $_.prev; next = Ptr $_.next }
        }
        Write-Host ($rows | Format-Table -AutoSize | Out-String).TrimEnd()
    }
}

# Step 4: wait for the server, then run the menu until Exit
foreach ($try in 1..20) { if ($state = Get-State) { break }; Start-Sleep 1 }
if (-not $state) { Read-Host 'Server did not start. Check the server window. Press Enter'; exit 1 }
Write-Host "`nC backend running at $base (server window is minimized in the taskbar)" -ForegroundColor Green
Show $state -StateOnly

try {
    while ($true) {
        Write-Host "`n1 Add  2 Select  3 Delete  4 Next  5 Previous  6 Reverse  7 Merge  8 Reset  9 Show  0 Exit" -ForegroundColor Magenta
        switch (Read-Host 'Choice') {
            '1' { $l = Pick-List; $t = Read-Host 'Title'; $a = Read-Host 'Artist'
                  Show (Send "action=add&playlist=$l&title=$(Enc $t)&artist=$(Enc $a)") }
            '2' { $l = Pick-List; Show (Send "action=select&playlist=$l&id=$(Enc (Read-Host 'Song ID'))") }
            '3' { $l = Pick-List; Show (Send "action=delete&playlist=$l&id=$(Enc (Read-Host 'Song ID'))") }
            '4' { Show (Send "action=next&playlist=$(Pick-List)") }
            '5' { Show (Send "action=previous&playlist=$(Pick-List)") }
            '6' { Show (Send "action=reverse&playlist=$(Pick-List)") }
            '7' { $l = Pick-List 'Merge INTO playlist (A/B)'; $src = if ($l -eq 'main') { 'secondary' } else { 'main' }
                  Show (Send "action=merge&playlist=$l&source=$src") }
            '8' { Show (Send 'action=reset') }
            '9' { Show (Get-State) -StateOnly }
            '0' { return }
            default { Write-Host 'Pick a number from the menu.' }
        }
    }
} finally {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
    Write-Host 'Backend stopped.'
}
