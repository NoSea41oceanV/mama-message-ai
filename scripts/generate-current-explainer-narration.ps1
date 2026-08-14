$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$scenes = Get-Content -Raw -Encoding utf8 (Join-Path $PSScriptRoot "current-explainer-scenes.json") | ConvertFrom-Json
$target = Join-Path $workspace "docs\submission\video\current-explainer-audio"
New-Item -ItemType Directory -Force -Path $target | Out-Null
$voice = New-Object -ComObject SAPI.SpVoice
$japanese = $voice.GetVoices() | Where-Object { $_.GetDescription() -like "*Haruka*" } | Select-Object -First 1
if ($japanese) { $voice.Voice = $japanese }
$voice.Rate = 0
try {
  for ($index = 0; $index -lt $scenes.Count; $index++) {
    $path = Join-Path $target ("scene-{0:D2}.wav" -f ($index + 1))
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    $stream = New-Object -ComObject SAPI.SpFileStream
    $format = New-Object -ComObject SAPI.SpAudioFormat
    try {
      $format.Type = 22
      $stream.Format = $format
      $stream.Open($path, 3, $false)
      $voice.AudioOutputStream = $stream
      [void]$voice.Speak([string]$scenes[$index].narration)
    } finally {
      $stream.Close()
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($format)
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($stream)
    }
  }
} finally {
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($voice)
}
