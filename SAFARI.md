# Safari — groundwork (not built yet)

The code is already written cross-browser so this folder converts to a Safari extension cleanly
**when we're ready**. We're iterating on Chrome first; this file is just the plumbing/notes so the
Safari step is mechanical later.

## What's already done for Safari compatibility

- **Namespace shim** — every script starts with `const api = globalThis.browser ?? globalThis.chrome;`
  and calls `api.*`. Safari/Firefox expose `browser`; Chrome exposes `chrome`. Same code, both work.
- **Promises, not callbacks** — all extension API calls are `await`ed, which is Safari's native style
  and also valid in Chrome MV3.
- **No Chrome-only APIs** — export uses a plain anchor-click download (works everywhere), so there's
  no `downloads` permission to special-case. Permissions are just `storage` + `activeTab`.
- **MV3** — Safari 16.4+ supports Manifest V3 service workers, content scripts, and popups.

## When we're ready to do Safari (must run on the Mac, e.g. the MacBook Air)

1. Install Xcode (from the App Store) — it ships the converter.
2. Convert this folder into an Xcode project:
   ```bash
   xcrun safari-web-extension-converter /path/to/breadcrumbs-extension
   ```
3. Open the generated `.xcodeproj` in Xcode, select the extension scheme, and **Build & Run**. The
   wrapper app launches; enable it in **Safari → Settings → Extensions**.
4. For local/personal use you can run it self-signed (you may need to allow unsigned extensions in
   Safari's Develop menu). Distributing via the App Store would require a paid Apple Developer
   account — not needed for a personal tool.

## Things to re-check at Safari time

- Background tabs: the "deep scan" opens order pages in background tabs. This is fine on macOS Safari
  but behaves differently / is limited on iOS Safari — desktop is the target.
- `host_permissions`: Safari prompts the user to grant per-site access on first use; expected.
- If we later add direct Monarch push (instead of JSON export), revisit how Safari handles the
  Monarch session — but today's export-to-JSON flow has no Safari-specific concerns.

Bottom line: keep developing in this one folder against Chrome. Safari is a build target we generate
from it, not a separate codebase.
