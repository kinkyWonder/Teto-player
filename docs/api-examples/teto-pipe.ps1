# Teto Player: читает именованный канал \\.\pipe\teto-player (Windows PowerShell 5+ / PowerShell 7)
while ($true) {
  try {
    $p = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'teto-player', [System.IO.Pipes.PipeDirection]::In)
    $p.Connect(5000)
    $r = New-Object System.IO.StreamReader($p, [Text.Encoding]::UTF8)
    while (($l = $r.ReadLine()) -ne $null) {
      $m = $l | ConvertFrom-Json
      switch ($m.event) {
        { $_ -in 'hello', 'track' } { if ($m.data.track) { "`n> $($m.data.track.artist) - $($m.data.track.title)" } else { "`n[stopped]" } }
        'line' { if ($m.data.line) { "  ~ $($m.data.line.text)" } }
      }
    }
  } catch { Write-Host 'Teto Player не запущен или трансляция выключена, повтор…' }
  finally { if ($p) { $p.Dispose() } }
  Start-Sleep 3
}
