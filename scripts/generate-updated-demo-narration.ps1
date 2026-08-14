$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$scenesPath = Join-Path $PSScriptRoot "updated-demo-scenes.json"
$audioDirectory = Join-Path $workspace "docs\submission\video\live-v2-audio"
$scenes = Get-Content -Raw -Encoding utf8 $scenesPath | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $audioDirectory | Out-Null
$voice = New-Object -ComObject SAPI.SpVoice
$haruka = $voice.GetVoices() | Where-Object { $_.GetDescription() -like "*Haruka*" } | Select-Object -First 1
if (-not $haruka) { throw "Microsoft Haruka Japanese voice is not installed." }
$voice.Voice = $haruka
$voice.Rate = 0

try {
  for ($index = 0; $index -lt $scenes.Count; $index++) {
    $path = Join-Path $audioDirectory ("scene-{0:D2}.wav" -f ($index + 1))
    $stream = New-Object -ComObject SAPI.SpFileStream
    $format = New-Object -ComObject SAPI.SpAudioFormat
    try {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      $format.Type = 22 # 22 kHz, 16-bit, mono PCM
      $stream.Format = $format
      $stream.Open($path, 3, $false)
      $voice.AudioOutputStream = $stream
      [void]$voice.Speak([string]$scenes[$index].narration)
    } catch {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      throw
    } finally {
      $stream.Close()
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($format)
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($stream)
    }
  }
} finally {
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($voice)
}

Get-ChildItem $audioDirectory -Filter "scene-*.wav" | Select-Object Name, Length
