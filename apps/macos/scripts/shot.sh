#!/bin/sh
# Captures the app's main window to a PNG:  scripts/shot.sh out.png
# With --screen it captures the window's rectangle of the screen instead, so
# popovers and menus (separate windows) are in the picture; bring the app to
# the front first.
BOUNDS=$(swift -e 'import CoreGraphics; let l = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]; for w in l where ((w["kCGWindowOwnerName"] as? String)?.hasPrefix("Qali") ?? false) && (w["kCGWindowLayer"] as? Int) == 0 { let b = w["kCGWindowBounds"] as! [String: Any]; if (b["Height"] as! Int) > 200 { print(w["kCGWindowNumber"]!, b["X"]!, b["Y"]!, b["Width"]!, b["Height"]!); break } }')
set -- "$@" $BOUNDS
if [ "$1" = "--screen" ]; then
  screencapture -x -R "$4,$5,$6,$7" "$2"
else
  screencapture -x -o -l "$2" "$1"
fi
