#!/usr/bin/env bash
# One-time setup of Redis inside WSL Ubuntu for COSMIC (run as root):
#   wsl -d Ubuntu-22.04 -u root -- bash /mnt/d/COSMIC/backend/scripts/configure-redis-wsl.sh
set -e
command -v redis-server >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redis-server; }
f=/etc/redis/redis.conf
sed -i -E 's/^#? *maxmemory [0-9].*/maxmemory 512mb/; s/^#? *maxmemory-policy .*/maxmemory-policy allkeys-lru/; s/^save [0-9]/# &/' "$f"
grep -qE '^maxmemory 512mb' "$f" || echo 'maxmemory 512mb' >> "$f"
grep -qE '^maxmemory-policy allkeys-lru' "$f" || echo 'maxmemory-policy allkeys-lru' >> "$f"
grep -qE '^save ""' "$f" || echo 'save ""' >> "$f"
systemctl enable redis-server >/dev/null 2>&1 || true
systemctl restart redis-server
echo "redis-server: $(systemctl is-active redis-server)"
echo "maxmemory: $(redis-cli config get maxmemory | tail -1)  policy: $(redis-cli config get maxmemory-policy | tail -1)"
