$ErrorActionPreference = 'Stop'
$target = 'root@deploy.balkhaev.com'
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15')
$remoteRoot = '/data/devhub/delopusk-mirrors'

function Invoke-Remote([string] $command) {
    # Pass scripts as data: PowerShell's native argument quoting must not
    # change nginx/Go templates, shell quotes or dollar variables.
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($command -replace "`r", '') + "`n"))
    $payload | & ssh @sshOptions $target 'base64 -d | sh'
    if ($LASTEXITCODE -ne 0) { throw "Remote operation failed ($LASTEXITCODE)" }
}

# These are fixed production hosts. Do not infer routes from user input or
# expose a wildcard reverse proxy. Existing file-provider files stay intact.
Invoke-Remote @'
set -eu
test "$(docker inspect coolify-proxy --format '{{(index .NetworkSettings.Networks "coolify").IPAddress}}')" = '10.0.1.7'
for domain in crm.balkhaev.com api.crm.balkhaev.com ggpick.balkhaev.com altay-mirror.balkhaev.com; do
  test "$(getent ahostsv4 "$domain" | head -1 | awk '{print $1}')" = '49.13.216.63'
done
mkdir -p /data/devhub/delopusk-mirrors
'@

foreach ($file in @('nginx.conf', 'compose.yaml', 'edge.yaml')) {
    & scp @sshOptions (Join-Path $PSScriptRoot $file) "${target}:${remoteRoot}/${file}.next"
    if ($LASTEXITCODE -ne 0) { throw "Upload failed: $file" }
}

Invoke-Remote @'
set -eu
cd /data/devhub/delopusk-mirrors
docker pull nginx:1.28-alpine
docker run --rm --user nginx --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:uid=101,gid=101,mode=1770 --entrypoint nginx -v /data/devhub/delopusk-mirrors/nginx.conf.next:/etc/nginx/nginx.conf:ro nginx:1.28-alpine -t
docker compose -f compose.yaml.next config -q
mv nginx.conf.next nginx.conf
mv compose.yaml.next compose.yaml
docker compose up -d --force-recreate --wait --wait-timeout 60
install -m 644 edge.yaml.next /data/coolify/proxy/dynamic/delopusk-mirrors.yaml.next
mv /data/coolify/proxy/dynamic/delopusk-mirrors.yaml.next /data/coolify/proxy/dynamic/delopusk-mirrors.yaml
mv edge.yaml.next edge.yaml
'@

Write-Output 'Proxy installed. Verify HTTPS, application pages and CRM CORS; see DELOPUSK-MIRRORS.md.'
