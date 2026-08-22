param([Parameter(Mandatory=$true)][string]$Target)
# Concatenates .mox-tmp\chunk-*.txt (sorted by name) into $Target, then removes them.
$root = "E:\MyCodes\Mox\.mox-tmp"
$chunks = Get-ChildItem -Path $root -Filter "chunk-*.txt" | Sort-Object Name
$content = ($chunks | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join ""
$dir = Split-Path -Parent $Target
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[IO.File]::WriteAllText($Target, $content, (New-Object System.Text.UTF8Encoding($false)))
$chunks | Remove-Item -Force
Write-Output ("assembled: " + $Target + " (" + $content.Length + " bytes from " + $chunks.Count + " chunks)")