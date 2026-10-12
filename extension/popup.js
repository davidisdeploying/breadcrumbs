// Cross-browser (Chrome + Safari). Uses the `api` alias and promises throughout.
// Chrome export = anchor-click download. Safari export = clipboard (it ignores the
// `download` attribute on a blob URL in a popup), with an explicit tab fallback.
const api = globalThis.browser ?? globalThis.chrome;

const $ = (id) => document.getElementById(id);
const log = (msg, cls = "") => {
  const el = $("log");
  el.innerHTML += `<span class="${cls}">${msg}</span>\n`;
  el.scrollTop = el.scrollHeight;
};
const SEL_FIELDS = ["orderLinkSel","itemRowSel","itemNameSel","itemPriceSel","dateSel","totalSel"];

// Safari ignores `download` on a blob URL in an extension popup (navigates to it instead).
// Detect Safari so export can branch. Chrome on macOS also has "Safari" in its UA, so the
// Apple-vendor check disambiguates.
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  && !!navigator.vendor && navigator.vendor.includes("Apple");

let activeTab = null;
let currentSiteId = null;

// Detect the store straight from the tab's URL — the popup always knows the URL, so this
// never depends on the content script being injected yet. (That dependency was the bug:
// a tab opened before the extension loaded had no content script, so detection failed
// until a manual refresh.) Keep this list in sync with the SITES registry in content.js.
function detectSite(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  if (host.includes("kroger.com")) return { id: "kroger", label: "Kroger" };
  if (host.includes("heb.com")) return { id: "heb", label: "H-E-B" };
  if (host === "amazon.com" || host.endsWith(".amazon.com")) return { id: "amazon", label: "Amazon" };
  return null;
}

async function init() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  const site = detectSite(tab?.url || "");
  const label = site ? site.label : null;
  currentSiteId = site ? site.id : null;
  $("ctxlabel").textContent = label ? `${label} ✓` : "not a supported store";
  // Show the site's own favicon (the store's brand mark) — pulled from the browser, no
  // page scraping, works for every store. Hide it if the tab has none or it's unsupported.
  // Safari hands back a favIconUrl that renders as an empty box without firing onerror, so
  // skip it entirely there — the icon is decorative and the label alone is enough.
  const icon = $("ctxicon");
  if (label && !IS_SAFARI && tab?.favIconUrl) {
    icon.onerror = () => { icon.hidden = true; };
    icon.src = tab.favIconUrl;
    icon.hidden = false;
  } else {
    icon.hidden = true;
  }
  $("inspect").disabled = $("scan").disabled = $("deepall").disabled = !label;

  const { cfg = {} } = await api.storage.local.get("cfg");
  const siteCfg = (currentSiteId && cfg[currentSiteId]) || {};
  SEL_FIELDS.forEach((k) => { if (siteCfg[k]) $(k).value = siteCfg[k]; });
  if (typeof BreadcrumbsConfig !== "undefined" && $("endpoint")) {
    $("endpoint").value = await BreadcrumbsConfig.getEndpoint();
  }
  await refreshCount();
  // If a scan is mid-flight (popup was closed and reopened), resume showing its progress.
  const { scanProgress } = await api.storage.local.get("scanProgress");
  if (scanProgress) updateProgress(scanProgress);
  if (!label) log("Open a supported store's purchases page (logged in), then reopen this.", "warn");
}

// ---- progress bar --------------------------------------------------------
function updateProgress(p) {
  const bar = $("progress");
  if (!p || !p.total) { bar.hidden = true; return; }
  bar.hidden = false;
  const pct = Math.max(2, Math.round((100 * p.done) / p.total));
  $("progressfill").style.width = pct + "%";
  const phase = p.phase === "pages" ? "Reading pages" : "Scanning orders";
  $("progresslabel").textContent = `${phase} ${p.done}/${p.total}`;
}
api.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SCAN_PROGRESS") updateProgress(msg);
  else if (msg.type === "SCAN_DONE") {
    updateProgress(null);
    refreshCount();
    const extra = `${msg.skipped ? ` Skipped ${msg.skipped} (no items).` : ""}${msg.failed ? ` ${msg.failed} to retry.` : ""}`;
    log(`Done — ${msg.count} order(s) stored.${extra}`, "ok");
  }
});

// If the popup was reopened (or regains focus) after a background scan, re-read storage
// so the count is never stale — fixes the "154/154 but Export (0)" reopen confusion.
window.addEventListener("focus", () => { refreshCount(); });

async function refreshCount() {
  const { orders = {} } = await api.storage.local.get("orders");
  const n = Object.keys(orders).length;
  if ($("count")) $("count").textContent = n;
  if ($("postCount")) $("postCount").textContent = n;
  if ($("export")) $("export").disabled = n === 0;
  if ($("postServer")) $("postServer").disabled = n === 0;
}

async function send(type) {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    try {
      return await api.tabs.sendMessage(tab.id, { type });
    } catch (e) {
      // No content script in this tab yet (it was open before the extension loaded, or
      // hasn't injected). Inject it on demand, then retry — so the user never has to
      // manually refresh the page. Static registration still handles the normal fast path.
      if (api.scripting?.executeScript) {
        await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        return await api.tabs.sendMessage(tab.id, { type });
      }
      throw e;
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

$("inspect").onclick = async () => {
  log("Inspecting page…");
  const r = await send("INSPECT");
  if (!r.ok) return log("Inspect failed: " + r.error, "err");
  const rep = r.report;
  log("URL: " + rep.url);
  log("Embedded JSON: " + (rep.hasEmbeddedJson ? rep.embeddedKeys.join(", ") : "none"), rep.hasEmbeddedJson ? "ok" : "warn");
  log("Link guesses:");
  rep.linkGuesses.forEach((g) => log(`  ${g.count.toString().padStart(3)}  ${g.sel}`, g.count ? "ok" : ""));
  log("Full dump in the page's DevTools console (look for [breadcrumbs]).", "warn");
};

$("dump").onclick = async () => {
  log("Dumping live DOM…");
  const r = await send("DUMP");
  if (!r.ok) return log("Dump failed: " + r.error, "err");
  const rep = r.report;
  log(`Nodes: ${rep.totalNodes} • data-testid values: ${rep.testIdCount}`, rep.testIdCount ? "ok" : "warn");
  log(`POT-* testids (${rep.potIds.length}):`, rep.potIds.length ? "ok" : "warn");
  rep.potIds.slice(0, 50).forEach((t) => log("  " + t));
  log(`Item rows w/ price (${rep.itemRows.length}):`);
  rep.itemRows.forEach((it) => { log(`  testid=${it.testid} <${it.tag}>`, "ok"); log(`   ${it.text}`); });
  if (rep.priceLeaves?.length) {
    log("Price leaf samples:");
    rep.priceLeaves.forEach((p) => log(`  <${p.tag}> ${p.cls} :: ${p.text}`));
  }
  log("Full allTestIds in the page console under [breadcrumbs] dump.", "warn");
};

$("scan").onclick = async () => {
  log("Scanning…");
  const r = await send("SCAN");
  if (!r.ok) return log("Scan failed: " + r.error, "err");
  const res = r.result;
  if (res.page === "list") {
    log(`Found ${res.orderUrls.length} order(s) on this page.`, "ok");
    log(`Opening each order briefly (~5s each, please wait)…`);
    const resp = await api.runtime.sendMessage({ type: "DEEP_SCAN", site: currentSiteId, orderUrls: res.orderUrls, limit: 25 });
    updateProgress(null);
    if (!resp?.ok) return log("Deep scan failed.", "err");
    log(`Captured ${resp.count} itemized order(s).`, "ok");
    if (resp.skipped) log(`Skipped ${resp.skipped} with no line items (e.g. fuel/pharmacy).`, "warn");
    if (resp.failed) log(`${resp.failed} didn't load in time — Gather again to retry those.`, "warn");
    await refreshCount();
  } else if (res.page === "detail") {
    const existing = (await api.storage.local.get("orders")).orders || {};
    existing[res.order.id] = res.order;
    await api.storage.local.set({ orders: existing });
    log(`Captured ${res.order.items.length} item(s) • total ${res.order.total || "?"} • ${res.order.date || "?"}`, "ok");
    res.order.items.slice(0, 6).forEach((it) =>
      log(`  ${it.qty > 1 ? it.qty + "× " : ""}${it.name} — ${it.price}`)
    );
    await refreshCount();
  } else {
    log(res.note || "Nothing matched.", "warn");
  }
};

$("deepall").onclick = async () => {
  // Must be on the order LIST page to read the pager.
  const pagerResp = await send("PAGER_INFO");
  const linksResp = await send("LIST_LINKS");
  if (!pagerResp.ok || !linksResp.ok || !linksResp.orderUrls?.length) {
    return log("Open your purchases list page first, then follow the trail.", "warn");
  }
  const pager = pagerResp.pager || {};
  const pages = pager.maxPage || 1;
  if (currentSiteId === "amazon") {
    log(`Deep scan: ${pager.filterUrls?.length || 0} Amazon year filter(s) detected.`, "ok");
  } else {
    log(`Deep scan: ${pages} page(s) of history detected.`, "ok");
  }
  if (currentSiteId !== "amazon" && pages > 1 && !(pager.pageLinks?.length) && !pager.pageParam) {
    log("Heads up: the pager has no direct page links — I'll try ?page=N. If later", "warn");
    log("pages come back empty, we'll need to scan them by hand. Page 1 is safe.", "warn");
  }
  log(`Reading all pages, then opening each order (~5s each). This can take a few minutes…`);
  const resp = await api.runtime.sendMessage({
    type: "ALL_HISTORY", site: currentSiteId, page1Urls: linksResp.orderUrls, pager, limit: 500
  });
  updateProgress(null);
  if (!resp?.ok) return log("Deep scan failed.", "err");
  log(`Crawled ${resp.pagesCrawled} page(s), saw ${resp.ordersSeen} order(s).`, "ok");
  log(`Captured ${resp.count} itemized order(s).`, "ok");
  if (resp.skipped) log(`Skipped ${resp.skipped} with no line items (e.g. fuel/pharmacy).`, "warn");
  if (resp.failed) log(`${resp.failed} didn't load — follow the trail again to retry those.`, "warn");
  await refreshCount();
};

$("export").onclick = async () => {
  const { orders = {} } = await api.storage.local.get("orders");
  const json = JSON.stringify(Object.values(orders), null, 2);

  if (IS_SAFARI) {
    // Safari: the anchor-click download just navigates to the blob (opens a tab). Use the
    // clipboard as the primary save — it's also fewer steps into the Monarch reconcile paste.
    try {
      await navigator.clipboard.writeText(json);
      log("Copied breadcrumbs-orders.json to the clipboard.", "ok");
      log("Paste it into the reconcile step, or into a new file saved as breadcrumbs-orders.json.", "warn");
    } catch (e) {
      // Clipboard blocked (rare — popup is focused on click). Open the JSON in a tab for Cmd-S.
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      await api.tabs.create({ url });
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      log("Opened the JSON in a tab — use Cmd-S to save as breadcrumbs-orders.json.", "warn");
    }
    return;
  }

  // Chrome: anchor-click download (unchanged — verified path).
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "breadcrumbs-orders.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log("Exported breadcrumbs-orders.json", "ok");
};

$("clear").onclick = async () => {
  await api.storage.local.set({ orders: {} });
  await refreshCount();
  log("Cleared captured orders.", "warn");
};

if ($("postServer")) {
  $("postServer").onclick = async () => {
    const { orders = {} } = await api.storage.local.get("orders");
    const payload = Object.values(orders);
    if (!payload.length) {
      return log("No orders collected to send.", "warn");
    }

    const endpoint = typeof BreadcrumbsConfig !== "undefined"
      ? await BreadcrumbsConfig.getEndpoint()
      : "http://alpha.tail3327f9.ts.net:8800";
    const targetUrl = endpoint.replace(/\/+$/, "") + "/api/import";
    log(`Sending ${payload.length} order(s) to ${endpoint}…`);

    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        log(`POST to service failed (HTTP ${res.status}): ${text || res.statusText}`, "err");
        log("  Hint: Are you connected to Tailscale? Is the breadcrumbs-history service running?", "warn");
        return;
      }

      const data = await res.json();
      const alertCount = Array.isArray(data.alerts) ? data.alerts.length : (data.alerts || 0);
      log(`Synced to server — ${data.new_order_count ?? 0} new order(s), ${data.duplicate_count ?? 0} duplicate(s), ${alertCount} alert(s).`, "ok");
    } catch (e) {
      log(`POST to service failed: ${e.message || String(e)}`, "err");
      log("  Hint: Are you connected to Tailscale? Is the breadcrumbs-history service running?", "warn");
    }
  };
}

$("save").onclick = async () => {
  let savedMsg = [];
  if (currentSiteId) {
    const { cfg = {} } = await api.storage.local.get("cfg");
    const sc = {};
    SEL_FIELDS.forEach((k) => (sc[k] = $(k).value.trim()));
    cfg[currentSiteId] = sc;
    await api.storage.local.set({ cfg });
    savedMsg.push(`selectors for ${currentSiteId}`);
  }
  const epInput = $("endpoint");
  if (epInput && epInput.value.trim() && typeof BreadcrumbsConfig !== "undefined") {
    const ok = await BreadcrumbsConfig.setEndpoint(epInput.value.trim());
    if (ok) {
      savedMsg.push("service endpoint");
    } else {
      log("Endpoint permission denied.", "err");
    }
  }
  if (savedMsg.length > 0) {
    log(`Saved ${savedMsg.join(" & ")}.`, "ok");
  } else if (!currentSiteId && (!epInput || !epInput.value.trim())) {
    log("Open a supported store to save selectors or enter a service endpoint.", "warn");
  }
};

init();
