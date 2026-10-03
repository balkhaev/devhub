<#
  Убирает «Пульт» из трея, из автозапуска и с рабочего стола. Сам пульт (если работает) и серверы проектов не
  трогает: пульт по-прежнему открывается через Пульт.cmd.
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'tray\bin\Пульт.exe'
$name = 'Пульт'

if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
    if (Test-Path $exe) { Start-Process -FilePath $exe -ArgumentList '--close' -Wait }
    Get-Process -Name $name -ErrorAction SilentlyContinue | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
}
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $name -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -Name $name -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk") -ErrorAction SilentlyContinue

Write-Output 'Пульт убран из трея, из автозапуска и с рабочего стола. Открыть его по-прежнему можно через Пульт.cmd.'
