# HELM logo assets

`apps/desktop/assets/helm.svg` is the maintained master: the established blue,
eight-spoke ship wheel with a circular hub and ring. Long, shaped handles retain
the original silhouette: rounded grip ends, tapered necks, and small collars.
All eight use the same profile and rotation around the wheel center. The whole
wheel is scaled inside the canvas so complete handles have equal transparent
margins, rather than being shortened to fit.
The old 512px raster had truncated, unequal cardinal handles; the unreferenced
1024px `app-icon-source.png` was separately cropped and has been removed.

After editing the SVG, run from `apps/desktop`:

```sh
npm ci
npm run icons:generate
npm run icons:check
```

The locked Tauri CLI generates the Windows ICO, Mac ICNS, desktop PNGs, Windows
Square/Store images, and existing mobile asset families. The same SVG is copied
to `public/helm.svg` for the browser favicon. Commit the master, generated assets,
and `assets/icon-manifest.json` together. The manifest records hashes without a
timestamp so the output can be reproduced. The generator sorts ICNS chunks by
type to remove the CLI's random chunk ordering without changing their payloads.
`npm run build` verifies the manifest,
desktop dimensions, transparency, padding, and icon-container frames before
building the frontend. No image service or extra graphics dependency is needed.

Tauri's `bundle.icon` and `build.rs` already reference/watch the bundled icons.
Windows titlebar/taskbar and shortcuts use those embedded resources. NSIS also
sets `installerIcon` explicitly to `icons/icon.ico`; leaving it unset ships the
packager's default installer artwork. `src-tauri/nsis/branding.nsh` sets
`MUI_UNICON` to that same icon at compile time, before the first installer page
initializes both icons. A runtime uninstall hook is too late. This uses NSIS's
supported forward-reference expansion because Tauri includes hooks before
defining `INSTALLERICON`. Mac Dock/Finder use the ICNS
in the bundle. The application content
uses its existing text headings. Rebuild platform installers after an asset
change; replacing a source image does not update an already installed app.

Validate a fresh candidate path before considering an OS cache issue. Do not
delete system icon caches or reset unrelated shortcuts. Private QA builds should
use their own bundle identity/install path and leave the accepted candidate intact.
