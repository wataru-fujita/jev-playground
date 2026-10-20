# Start the playground so it is reachable only over Tailscale (not on the LAN, not on the internet).
# Phone: turn Tailscale on, then open http://<this PC's Tailscale IP>:3210
#
# Secrets: put TYPESAFE_API_KEY in a .env file. By default ./.env is read; to keep the key out of a
# synced folder (OneDrive etc.), set JEV_ENV_FILE to a file elsewhere.
$ts = "$env:ProgramFiles\Tailscale\tailscale.exe"
$ip = (& $ts ip -4 | Select-Object -First 1).Trim()
if (-not $ip) { throw "Tailscale IP が取得できません。Tailscale が起動しているか確認してください。" }
$env:HOST = $ip
Set-Location $PSScriptRoot
$envFile = if ($env:JEV_ENV_FILE) { $env:JEV_ENV_FILE } else { Join-Path $PSScriptRoot ".env" }
Write-Host "スマホから: http://${ip}:3210"
node "--env-file-if-exists=$envFile" server.ts
