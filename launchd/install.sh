#!/bin/bash
# Install + load the daily LaunchAgent (runs the pipeline every morning at 8:00).
set -e
SRC="/Users/Home/Research/Articles of Interest/_ncbi-feed-app/launchd/com.ncbifeed.daily.plist"
DEST="$HOME/Library/LaunchAgents/com.ncbifeed.daily.plist"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST"
launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "Loaded com.ncbifeed.daily — runs daily at 08:00."
echo "Run it once now to test:  launchctl start com.ncbifeed.daily"
echo "Watch the log:            tail -f \"/Users/Home/Research/Articles of Interest/_ncbi-feed-app/logs/daily.out.log\""
echo "Optional (run even with lid closed):  sudo pmset repeat wakeorpoweron MTWRFSU 07:55:00"
