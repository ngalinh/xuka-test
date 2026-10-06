#!/bin/bash
# Hourly snapshot of xuka_data.json, kept for 7 days then auto-pruned.
# Installed as a cron job by .github/workflows/deploy.yml. Snapshots the live
# data dir, which lives OUTSIDE the platform bot folder (wiped on reload).
# Override the location with XUKA_DATA_DIR if needed.
set -euo pipefail
cd "${XUKA_DATA_DIR:-/home/vmadmin/xuka-data}"

mkdir -p backups

if [ -f xuka_data.json ]; then
  cp xuka_data.json "backups/xuka_data-$(date +%Y%m%d-%H%M%S).json"
fi

find backups -name 'xuka_data-*.json' -mtime +7 -delete
