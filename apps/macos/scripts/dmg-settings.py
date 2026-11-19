# dmgbuild settings for the drag-to-install DMG (scripts/dmg.sh).
# Icon centres must match scripts/gen-dmg-background.swift.
import os.path

app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)
background = defines["background"]  # noqa: F821
app_name = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
files = [app]
# The volume shows the app's own icon when it mounts.
icon = os.path.join(app, "Contents/Resources/AppIcon.icns")
symlinks = {"Applications": "/Applications"}
# No hide_extensions: it sets FinderInfo on Qali.app, which breaks the
# signature (`codesign --verify --strict` calls it detritus).

# The frame includes Finder's ~30pt title bar; the content is the 800x440 art.
window_rect = ((200, 160), (800, 470))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False

icon_size = 128
text_size = 13
arrange_by = None
icon_locations = {
    app_name: (270, 170),
    "Applications": (530, 170),
}
