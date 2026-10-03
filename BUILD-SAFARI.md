# Build Breadcrumbs for Safari (local / personal use)

This turns the existing extension folder into a Safari extension that runs in **your own**
Safari on the MacBook Air. No Apple Developer account, no App Store — that's only needed to
distribute to *other* people. The code needs no changes; Safari is a build target generated
from this same folder.

> Run everything below **on the MacBook Air** (macOS with a display). The Mini can't do this —
> the converter and Xcode are macOS-only, and there's no Photos/Safari signing path there.

---

## 0. One-time prerequisites

1. **Get the extension folder onto the Air.** Unzip the latest `breadcrumbs-extension-vX.Y.Z.zip`
   somewhere stable, e.g. `~/dev/breadcrumbs-extension`. Confirm it contains `manifest.json`,
   `background.js`, `content.js`, `popup.*`, and the `icons/` folder.
   ```bash
   cd ~/dev/breadcrumbs-extension
   ls            # manifest.json background.js content.js popup.html popup.css popup.js icons assets
   ```

2. **Install Xcode** from the Mac App Store (large download, be patient). Then accept the license
   and make sure command-line tools are pointed at the full Xcode (not just the CLT shim):
   ```bash
   sudo xcodebuild -license accept
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   xcrun --find safari-web-extension-converter   # should print a path, proving the tool exists
   ```

---

## 1. Convert the folder into an Xcode project

From the parent directory (so the generated project lands next to the source, not inside it):

```bash
cd ~/dev
xcrun safari-web-extension-converter ./breadcrumbs-extension \
  --app-name "Breadcrumbs" \
  --bundle-identifier cc.davidgomez.breadcrumbs \
  --macos-only \
  --no-prompt
```

What the flags do:
- `--app-name "Breadcrumbs"` — the host app's display name (Safari extensions live inside a tiny
  host app; this is what shows in Finder/Launchpad).
- `--bundle-identifier cc.davidgomez.breadcrumbs` — reverse-DNS id. Use your own domain style;
  anything unique and stable is fine for local use.
- `--macos-only` — skip the iOS target. iOS Safari can't do the background-tab deep scan, so
  there's no point generating it now (revisit later as a reduced single-page-capture build).
- `--no-prompt` — don't pause to ask; just generate.

It prints the generated project path (under `~/dev/Breadcrumbs/`) and usually offers to open Xcode.
If it warns that some manifest keys were changed/ignored, that's normal — note them but they're
almost always cosmetic (icons, optional fields).

---

## 2. Build & run in Xcode

1. Open the generated project (either Xcode opened it for you, or):
   ```bash
   open ~/dev/Breadcrumbs/Breadcrumbs.xcodeproj
   ```
2. In the scheme selector (top bar), pick **Breadcrumbs (macOS)**.
3. Press **▶ Run** (Cmd-R). Xcode builds the host app and launches it. The host app window just
   explains how to enable the extension in Safari — that's expected; it's a launcher, not the UI.

If the build fails on **signing** ("requires a development team"):
- Select the project in the navigator → the **Breadcrumbs** target → **Signing & Capabilities**.
- Set **Team** to your personal Apple ID team (Xcode → Settings → Accounts → add your Apple ID;
  the free "Personal Team" is enough for local running).
- Leave **Automatically manage signing** checked. Re-run.

---

## 3. Enable it in Safari

1. Safari → **Settings** → **Advanced** → tick **Show features for web developers** (adds the
   Develop menu).
2. Safari → **Develop** menu → **Allow Unsigned Extensions** (you'll re-toggle this after reboots
   for a self-signed/free-team build — that's the cost of not paying for a Developer account).
3. Safari → **Settings** → **Extensions** → enable **Breadcrumbs**.
4. It'll ask for permission on `kroger.com` — grant it (Safari does per-site permission prompts;
   "Always Allow on This Website" is the smooth choice for your own use).

---

## 4. Smoke-test (same as the Chrome acceptance run)

1. Log into Kroger in Safari, go to `kroger.com/mypurchases`.
2. Click the Breadcrumbs toolbar icon → the popup should show **Kroger ✓**.
3. **Scan recent orders** → watch the progress bar, confirm it captures the page's orders.
4. **Export JSON** → confirm `breadcrumbs-orders.json` downloads and looks right.
5. Open one order's `/detail/` page and **Scan** it singly as a cross-check.

The thing to watch on Safari specifically: the **deep scan opens background tabs**. On macOS Safari
this works, but tab handling differs from Chrome, so watch the first **Deep scan — entire history**
run. If background tabs don't reliably load/extract, the fallback is exactly the two-tier UI we
built — "Scan recent orders" page-by-page still works, and we'd only need to tune the per-tab wait
in `background.js` for Safari's timing.

---

## What's deliberately NOT here

- **No iOS build.** iOS Safari extensions can't open background tabs, so the deep-scan model doesn't
  port as-is. iOS is a future *reduced* build (capture the order page you're viewing, one at a time),
  not a recompile of this one.
- **No distribution.** Letting *other* people install this requires the Mac App Store: a paid
  ($99/yr) Apple Developer account, app review, privacy disclosures, and a polished host app. That's
  a product decision for later — keep this local until Kroger is rock-solid.

## Bottom line

One folder, two browsers. You develop against Chrome (load-unpacked, instant reload) and regenerate
the Safari build with the single `xcrun` command above whenever you want it current. If the code
changes, re-run step 1 (or just drag the updated files into the generated project's
`.../Breadcrumbs Extension/Resources/` and rebuild).
