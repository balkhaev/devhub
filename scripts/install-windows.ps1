<#
  Ставит «Пульт» на этот компьютер: собирает программу для трея (tray\bin\Пульт.exe), кладёт ярлык «Пульт» на
  рабочий стол, включает запуск при входе в Windows и запускает значок. Повторный запуск обновляет всё это.
  -NoStart: собрать и поставить, но значок сейчас не запускать.
#>
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'tray\bin'
$exe = Join-Path $bin 'Пульт.exe'
$icon = Join-Path $bin 'pult.ico'
$source = Join-Path $root 'tray\Tray.cs'
$name = 'Пульт'# Development wrappers outside D:\code find this hub through the per-user registration.$devhubBun = (Get-Command bun -ErrorAction Stop).Source& $devhubBun (Join-Path $root 'scripts\install-client.ts')if ($LASTEXITCODE -ne 0) { throw 'Не удалось зарегистрировать devhub для dev-команд проектов.' }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Не найден компилятор C# из .NET Framework 4 (csc.exe).' }

# The running tray holds its program: ask it to close (the hub and the project servers keep running).
if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
    if (Test-Path $exe) { Start-Process -FilePath $exe -ArgumentList '--close' -Wait }
    Get-Process -Name $name -ErrorAction SilentlyContinue | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
}

New-Item -ItemType Directory -Force -Path $bin | Out-Null
function Build([string[]]$More) {
    $arguments = @(
        '/nologo', '/target:winexe', '/optimize+', '/codepage:65001', "/out:$exe",
        '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll'
    ) + $More + @($source)
    & $csc @arguments
    if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась: csc вернул $LASTEXITCODE." }
}
# The program draws its own icon; the second build puts that icon into it.
Build @()
Start-Process -FilePath $exe -ArgumentList @('--write-icon', "`"$icon`"") -Wait
Build @("/win32icon:$icon")

$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $desktop "$name.lnk"))
$link.TargetPath = $exe
$link.WorkingDirectory = $root
$link.IconLocation = "$exe,0"
$link.Description = 'Пульт: серверы разработки всех проектов и их страницы'
$link.Save()

Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $name -Value "`"$exe`" --background"
# If it was switched off in Task Manager, switch it on again.
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -Name $name -ErrorAction SilentlyContinue

Write-Output "Собран: $exe"
Write-Output "Ярлык «$name» на рабочем столе; запуск при входе в Windows включён."
if (-not $NoStart) {
    Start-Process -FilePath $exe -ArgumentList '--background'
    Write-Output 'Значок пульта в трее: щелчок по нему открывает пульт.'
}
