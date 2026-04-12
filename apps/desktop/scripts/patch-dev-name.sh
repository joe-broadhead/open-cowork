#!/bin/bash
# Patch Electron's Info.plist in dev mode so dock shows "Open Cowork"
ELECTRON_APP=$(dirname $(node -e "console.log(require('electron'))"))/../Info.plist
if [ -f "$ELECTRON_APP" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Open Cowork" "$ELECTRON_APP" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Open Cowork" "$ELECTRON_APP" 2>/dev/null
fi
