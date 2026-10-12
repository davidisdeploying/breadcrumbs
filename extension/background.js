// Minimal MV3 service worker. Cross-browser (Chrome + Safari). Sets defaults and
// orchestrates the optional "deep scan" that visits each order's detail page in a
// background tab to collect its items.

const api = globalThis.browser ?? globalThis.chrome;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

api.runtime.onInstalled.addListener(async () => {
  const d = await api.storage.local.get("cfg");
  if (!d.cfg) {
    // cfg is now per-store: { <storeId>: {selector overrides} }. Empty = use built-in defaults.
    await api.storage.local.set({ cfg: {}, orders: {} });
  }
});

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        api.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    api.tabs.onUpdated.addListener(listener);
  });
}

// Open a URL in a background tab, wait for render, ask the content script to extract, close it.
// Returns { ok:true, order } on success, { ok:false, reason:"no-items" } for a page that
// rendered but has nothing to itemize (fuel/pharmacy), or { ok:false, reason:"error" } on failure.
async function scrapeOrderTab(url) {
  const tab = await api.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForComplete(tabId);
    await sleep(2800); // let the SPA render the receipt
    let resp = await api.tabs.sendMessage(tabId, { type: "SCAN" });
    let order = resp?.ok ? (resp.result?.order || null) : null;
    // Background tabs can hydrate slower than the foreground; if nothing came back,
    // wait a bit more and try once more before giving up on this order.
    if (!order || !order.items?.length) {
      await sleep(2500);
      try { resp = await api.tabs.sendMessage(tabId, { type: "SCAN" }); } catch {}
      order = resp?.ok ? (resp.result?.order || null) : null;
    }
    if (order && order.items?.length) return { ok: true, order };
    // resp.ok means the content script ran and simply found no product rows (fuel, etc.)
    // — a legitimate skip, not a load failure.
    if (resp && resp.ok) return { ok: false, reason: "no-items" };
    return { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    try { await api.tabs.remove(tabId); } catch {}
  }
}

// Push progress to the popup (if open) and persist it so reopening the popup resumes the view.
function sendProgress(p) {
  try { api.runtime.sendMessage({ type: "SCAN_PROGRESS", ...p }); } catch {}
  api.storage.local.set({ scanProgress: p });
}

// Open a list page in a background tab and return its order detail URLs.
async function readListPage(url) {
  const tab = await api.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForComplete(tabId);
    await sleep(2500);
    let resp = await api.tabs.sendMessage(tabId, { type: "LIST_LINKS" });
    let urls = resp?.ok ? (resp.orderUrls || []) : [];
    if (!urls.length) {
      await sleep(2000);
      try { resp = await api.tabs.sendMessage(tabId, { type: "LIST_LINKS" }); } catch {}
      urls = resp?.ok ? (resp.orderUrls || []) : [];
    }
    return urls;
  } catch {
    return [];
  } finally {
    try { await api.tabs.remove(tabId); } catch {}
  }
}

// Amazon history is grouped by year and paginated with a single real "Next" link.
// Return both the order links and the next page discovered from the rendered page.
async function readListPageInfo(url) {
  const tab = await api.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForComplete(tabId);
    await sleep(2500);
    let resp = await api.tabs.sendMessage(tabId, { type: "LIST_PAGE_INFO" });
    if (!resp?.ok || !resp.orderUrls?.length) {
      await sleep(2000);
      try { resp = await api.tabs.sendMessage(tabId, { type: "LIST_PAGE_INFO" }); } catch {}
    }
    return resp?.ok
      ? { orderUrls: resp.orderUrls || [], nextHref: resp.pager?.nextHref || "" }
      : { orderUrls: [], nextHref: "" };
  } catch {
    return { orderUrls: [], nextHref: "" };
  } finally {
    try { await api.tabs.remove(tabId); } catch {}
  }
}

// Scrape a set of order detail URLs, with progress, returning {collected, skipped, failed}.
async function scrapeOrders(urls) {
  const collected = {};
  let skipped = 0, failed = 0, i = 0;
  for (const url of urls) {
    const r = await scrapeOrderTab(url);
    if (r.ok && r.order?.items?.length) collected[r.order.id] = r.order;
    else if (r.reason === "no-items") skipped++;
    else failed++;
    i++;
    sendProgress({ phase: "orders", done: i, total: urls.length });
  }
  return { collected, skipped, failed };
}

async function persist(collected) {
  const existing = (await api.storage.local.get("orders")).orders || {};
  await api.storage.local.set({ orders: { ...existing, ...collected } });
}

// Tell any open popup the scan finished, so an orphaned/reopened popup refreshes its
// count without the user having to close and reopen it.
function broadcastDone(summary) {
  try { api.runtime.sendMessage({ type: "SCAN_DONE", ...summary }); } catch {}
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "DEEP_SCAN") {
    (async () => {
      const urls = msg.orderUrls.slice(0, msg.limit || 25);
      const { collected, skipped, failed } = await scrapeOrders(urls);
      await persist(collected);
      await api.storage.local.set({ scanProgress: null });
      const summary = { count: Object.keys(collected).length, skipped, failed };
      broadcastDone(summary);
      sendResponse({ ok: true, ...summary });
    })();
    return true;
  }

  if (msg.type === "ALL_HISTORY") {
    (async () => {
      const page1Urls = msg.page1Urls || [];
      const pager = msg.pager || {};
      const maxPage = pager.maxPage || 1;
      const all = new Set(page1Urls);

      if (msg.site === "amazon") {
        const visitedPages = new Set();
        let pagesCrawled = 0;
        const starts = pager.filterUrls || [];

        for (let f = 0; f < starts.length; f++) {
          let nextUrl = starts[f];
          let pagesForFilter = 0;
          while (nextUrl && !visitedPages.has(nextUrl) && pagesForFilter < 100) {
            visitedPages.add(nextUrl);
            const info = await readListPageInfo(nextUrl);
            info.orderUrls.forEach((u) => all.add(u));
            nextUrl = info.nextHref;
            pagesForFilter++;
            pagesCrawled++;
          }
          sendProgress({ phase: "pages", done: f + 1, total: starts.length });
        }

        const urls = [...all].slice(0, msg.limit || 500);
        const { collected, skipped, failed } = await scrapeOrders(urls);
        await persist(collected);
        await api.storage.local.set({ scanProgress: null });
        const count = Object.keys(collected).length;
        broadcastDone({ count, skipped, failed });
        sendResponse({
          ok: true,
          count,
          skipped,
          failed,
          pages: pagesCrawled,
          ordersSeen: urls.length,
          pagesCrawled
        });
        return;
      }

      // Build URLs for pages 2..maxPage. Prefer real page-anchor hrefs; fall back to a
      // page param if the URL uses one; last resort, best-effort ?page=N.
      const byNum = new Map((pager.pageLinks || []).map((p) => [p.n, p.href]));
      const pageUrls = [];
      for (let n = 2; n <= maxPage; n++) {
        if (byNum.has(n)) { pageUrls.push(byNum.get(n)); continue; }
        if (pager.base) {
          try {
            const u = new URL(pager.base);
            u.searchParams.set(pager.pageParam || "page", n);
            pageUrls.push(u.href);
          } catch {}
        }
      }

      // Phase 1: gather every order link across the additional pages.
      let pdone = 0;
      for (const pu of pageUrls) {
        (await readListPage(pu)).forEach((u) => all.add(u));
        pdone++;
        sendProgress({ phase: "pages", done: pdone, total: pageUrls.length });
      }

      // Phase 2: scrape every collected order.
      const urls = [...all].slice(0, msg.limit || 500);
      const { collected, skipped, failed } = await scrapeOrders(urls);
      await persist(collected);
      await api.storage.local.set({ scanProgress: null });
      const count = Object.keys(collected).length;
      broadcastDone({ count, skipped, failed });
      sendResponse({
        ok: true,
        count,
        skipped, failed,
        pages: maxPage,
        ordersSeen: urls.length,
        pagesCrawled: pageUrls.length + 1
      });
    })();
    return true;
  }
});
