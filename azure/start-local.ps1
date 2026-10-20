# Run the whole app locally (static site + Functions) with the SWA CLI.
#
# Secrets (TYPESAFE_API_KEY, APP_PASSWORD or APP_USERS) are read from a .env file.
# By default ./.env is used; to keep them out of a synced folder (cloud-synced drives), set JEV_ENV_FILE.
# Azure Functions Core Tools may not support the newest Node. If so, set JEV_NODE22_BIN to the folder
# that contains a Node 22 executable (same major as apiRuntime node:22).
Set-Location $PSScriptRoot
$envFile = if ($env:JEV_ENV_FILE) { $env:JEV_ENV_FILE } else { Join-Path $PSScriptRoot ".env" }
if (-not (Test-Path $envFile)) { throw ".env が見つかりません: $envFile" }
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
}
if ($env:JEV_NODE22_BIN) { $env:PATH = "$($env:JEV_NODE22_BIN);" + $env:PATH }
$env:FUNCTIONS_WORKER_RUNTIME = "node"
$env:AzureWebJobsStorage = ""
swa start app --api-location api
