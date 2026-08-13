$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $workspace "public\assets\audio"
$replies = Get-Content -Raw -Encoding utf8 (Join-Path $PSScriptRoot "demo-replies.json") | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$voice = New-Object -ComObject SAPI.SpVoice
$haruka = $voice.GetVoices() | Where-Object { $_.GetDescription() -like "*Haruka*" } | Select-Object -First 1
if (-not $haruka) { throw "Microsoft Haruka Japanese voice is not installed." }
$voice.Voice = $haruka
$voice.Rate = 0

try {
  foreach ($property in $replies.PSObject.Properties) {
    $path = Join-Path $outputDirectory "$($property.Name).wav"
    $stream = New-Object -ComObject SAPI.SpFileStream
    try {
      $stream.Open($path, 3, $false)
      $voice.AudioOutputStream = $stream
      [void]$voice.Speak([string]$property.Value)
    } finally {
      $stream.Close()
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($stream)
    }
  }
} finally {
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($voice)
}

Get-ChildItem $outputDirectory -Filter "*.wav" | Select-Object Name, Length
