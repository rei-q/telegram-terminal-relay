# Registers the logon task "telegram-terminal-relay" that runs the Telegram listener (relayd). -Uninstall removes it.
# -Node is the full path of node.exe (the installer passes the Node that runs it).
param([switch]$StartNow, [switch]$Uninstall, [string]$Node)
$name = 'telegram-terminal-relay'
if ($Uninstall) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; return }
if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'pass -Node with the full path of node.exe' }
$script = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\relayd.mjs'
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$Node`" `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Priority 4   # 4 is normal priority; the task default (7) is below normal
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
if ($StartNow) { Start-ScheduledTask -TaskName $name }
