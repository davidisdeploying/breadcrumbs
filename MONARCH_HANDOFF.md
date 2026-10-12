# Monarch handoff (MCP)

The fetcher stays Monarch-agnostic: it produces itemized data + receipt images and knows nothing
about Monarch. This last mile hands that output to an AI agent with Monarch MCP **write** access,
which matches each Kroger order to the already-posted card transaction and splits it by category.
The agent does the fuzzy matching and categorization that a deterministic script handles badly.

The reconcile logic lives in `monarch_reconcile_prompt.md`.

## Pick your mode

**Interactive (recommended to start) — official Monarch connector.**
Monarch ships an official MCP connector: Monarch → Settings → Integrations, authorize in the
browser, and grant the **write** scope. Add it to your AI client (Claude, etc.), then paste the
reconcile prompt and point it at your `receipts` folder. Cleanest auth — browser authorization, no
Monarch secret stored locally — and Monarch states it doesn't retain prompts/responses. Writes are
rate-limited (bulk calls capped ~20 items; heavy use may need Monarch Plus).

**Headless / scheduled — local community server.**
Remote claude.ai-style connectors (including Monarch's official one) don't reliably appear in
`claude -p` headless runs — the tool list is frozen before the remote connection establishes, so
only locally-configured MCP servers surface. So for the cron version, run a local community server
that exposes split/write tools. Trade-off: it stores a session token locally (in the OS keychain,
not the repo) and is unofficial, so it can break on Monarch changes.

## Headless setup

1. One-time auth for the local server (stores a keychain token so unattended runs don't prompt):
   ```bash
   uvx monarch-mcp           # triggers a browser login the first time; complete MFA
   ```
2. Add a project `.mcp.json` so `claude -p` auto-discovers it:
   ```json
   {
     "mcpServers": {
       "monarch": { "command": "uvx", "args": ["monarch-mcp", "--enable-write"] }
     }
   }
   ```
3. Run it (note: don't use `--bare`, which skips `.mcp.json` discovery). Pre-approve the tools so it
   doesn't stall on a permission prompt:
   ```bash
   claude -p "$(cat monarch_reconcile_prompt.md)" \
     --allowedTools "Read,mcp__monarch" \
     --permission-mode acceptEdits \
     --output-format json
   ```
   Confirm the exact server/tool identifiers with `/mcp` in an interactive session first — the
   `mcp__monarch` prefix follows the key you used in `.mcp.json`. For unattended billing, either be
   logged in via `claude` or set `ANTHROPIC_API_KEY`; each run costs tokens.

## Schedule it (after a clean plan-only run)

```cron
30 7 * * * cd /home/you/breadcrumbs && \
  claude -p "$(cat monarch_reconcile_prompt.md)" \
    --allowedTools "Read,mcp__monarch" --permission-mode acceptEdits \
    --output-format json >> reconcile.log 2>&1
```
Run the fetcher first (earlier cron slot), then this. The `kroger-receipt` tag plus
`receipts/reconciled.json` keep re-runs idempotent.

## Before trusting it on a schedule
- Do one **plan-only** run (the prompt enforces this on first execution) and eyeball the matches and
  category splits. A wrong amount-match is the thing to catch here.
- Confirm the connected server actually exposes a split tool; if not, the prompt falls back to
  single-category + itemized note and says so in the report.
- Watch `reconcile.log` for the first week — it's an LLM making the calls, so it's non-deterministic;
  the strict match tolerances and skip-on-uncertainty rule are what keep that safe.
