# Start Redis for COSMIC without Docker: Redis from Ubuntu's packages inside WSL (Ubuntu-22.04),
# running as a systemd service configured with maxmemory 512mb + allkeys-lru.
# WSL forwards localhost:6379 to Windows, so REDIS_URL=redis://localhost:6379/0 just works.
#
# Keep this window open: WSL stops the Ubuntu VM (and Redis) when nothing is attached to it.
# First time only:  wsl -d Ubuntu-22.04 -u root -- apt-get install -y redis-server
param([string]$Distro = "Ubuntu-22.04")

wsl -d $Distro -u root -- systemctl start redis-server
$state = wsl -d $Distro -u root -- systemctl is-active redis-server
Write-Host "Redis in WSL ($Distro): $state on localhost:6379. Keep this window open; Ctrl+C stops it."
wsl -d $Distro -u root -- sleep infinity
