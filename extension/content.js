// Runs inside your real, logged-in store tab (Kroger, H-E-B). Because the page is one YOU
// opened and authenticated, it's already past any bot protection — this script only READS
// what's on the page. It never logs in, automates, or disguises anything.
// Kroger is read via DOM selectors; H-E-B via its embedded __NEXT_DATA__ JSON.

// Cross-browser namespace: Safari/Firefox expose `browser`, Chrome exposes `chrome`.
const api = globalThis.browser ?? globalThis.chrome;

// ---- helpers -------------------------------------------------------------

// Many retail SPAs embed page data as JSON in the DOM — a far more robust source than
// scraping rendered HTML. Inspect surfaces whether Kroger does.
function readEmbeddedJson() {
  const out = {};
  const next = document.getElementById("__NEXT_DATA__");
  if (next) {
    try { out.__NEXT_DATA__ = JSON.parse(next.textContent); } catch {}
  }
  for (const key of ["__PRELOADED_STATE__", "__APOLLO_STATE__", "__INITIAL_STATE__"]) {
    if (window[key]) out[key] = window[key];
  }
  return out;
}

function topKeys(obj, depth = 2) {
  if (!obj || typeof obj !== "object" || depth < 0) return typeof obj;
  const o = {};
  for (const k of Object.keys(obj).slice(0, 40)) o[k] = topKeys(obj[k], depth - 1);
  return o;
}

// ---- H-E-B: JSON-first extraction ---------------------------------------
// H-E-B runs on Next.js and bakes full order data into <script id="__NEXT_DATA__">.
// We read structured fields straight from it — no CSS selectors, no DOM scraping,
// real numeric prices. Far more durable than per-class selectors, and a reusable
// pattern for other Next.js grocery sites.
function readNextData() {
  const el = document.getElementById("__NEXT_DATA__");
  if (!el) return null;
  try { return JSON.parse(el.textContent); } catch { return null; }
}

// H-E-B prices come as {amount: 0.87, formattedAmount: "$0.87"} — keep the "$" string
// to match the export shape used across stores.
const amt = (p) => (p && (p.formattedAmount || (typeof p.amount === "number" ? "$" + p.amount.toFixed(2) : ""))) || "";

function isoDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  const m = String(s).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}

// Order LIST page → detail URLs (one per recent order). H-E-B shows only the recent
// handful and has no pager, which is fine for weekly/monthly imports.
function hebListOrders(nd) {
  const orders = nd?.props?.pageProps?.orders;
  if (!Array.isArray(orders)) return null;
  return orders.filter((o) => o && o.orderId)
    .map((o) => `https://www.heb.com/my-account/order-history/${o.orderId}`);
}

// Order DETAIL page → one normalized order {id,date,total,url,items:[{name,qty,price,unitPrice}]}.
function hebDetailOrder(nd) {
  const order = nd?.props?.pageProps?.order;
  if (!order || !Array.isArray(order.orderItems)) return null;

  const items = order.orderItems.map((it) => {
    const paid = it.totalLineItemPricePaid || it.totalLineItemPrice || {};
    const unit = it.totalUnitPrice || {};
    const fq = typeof it.fulfilledQuantity === "number" ? it.fulfilledQuantity : null;
    const qty = fq != null ? fq : (typeof it.quantity === "number" ? it.quantity : 1);
    const prod = it.product || {};
    return {
      name: prod.fullDisplayName || prod.displayName || prod.name || "",
      qty,
      price: amt(paid),       // what actually hit the card for this line ($0.00 for free promo items)
      unitPrice: amt(unit),
      // Keep items actually received — including free promo items ($0.00 but fulfilled, e.g.
      // a "Your savings" giveaway). Drop only genuinely removed/unfulfilled lines, which come
      // through with fulfilledQuantity 0. Unknown fulfillment → keep (better than dropping a real line).
      _fulfilled: fq == null ? true : fq > 0
    };
  }).filter((i) => i.name && i.price && i._fulfilled)
    .map(({ _fulfilled, ...i }) => i);

  // Total: prefer the order's own price summary, then the charged payment.
  const pd = order.priceDetails || {};
  const total =
    amt(pd.total) || amt(pd.orderTotal) || amt(pd.grandTotal) || amt(pd.amountCharged) ||
    amt(pd.estimatedTotal) ||
    (Array.isArray(order.payments) && order.payments[0] && amt(order.payments[0])) || "";

  const date = isoDate(order.orderPlacedOnDateTime) || isoDate(order.orderTimeslot?.startTime);

  return {
    retailer: "heb",
    id: order.orderId || location.pathname.split("/").filter(Boolean).pop() || String(Date.now()),
    url: location.href,
    date,
    total,
    items
  };
}

// ---- Amazon: rendered order-history extraction --------------------------
// Amazon's account pages are server-rendered HTML. The useful hooks are semantic
// URL/data-component attributes rather than the generic a-* layout classes.
function moneyNumber(s) {
  const n = Number(String(s || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function moneyString(n) {
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
}

function moneyCents(s) {
  const n = moneyNumber(s);
  return n == null ? null : Math.round(n * 100);
}

function amazonListOrders() {
  return [...new Set(
    [...document.querySelectorAll('a[href*="/your-orders/order-details?orderID="]')]
      .map((a) => a.href)
      .filter(Boolean)
  )];
}

function amazonHistoryInfo() {
  const select = document.querySelector("#time-filter");
  const action = select?.form?.action;
  const filterUrls = action
    ? [...select.options]
      .filter((o) => /^year-\d{4}$/.test(o.value))
      .map((o) => {
        const u = new URL(action, location.href);
        u.searchParams.set(select.name || "timeFilter", o.value);
        return u.href;
      })
    : [];
  const next = [...document.querySelectorAll("a[href]")]
    .find((a) => /^\s*next\s*→?\s*$/i.test(a.textContent || "") && a.href.includes("startIndex="));
  return { filterUrls, nextHref: next?.href || "" };
}

function amazonDetailOrder() {
  const url = new URL(location.href);
  const body = (document.body.innerText || "").replace(/\s+/g, " ");
  const orderId = url.searchParams.get("orderID") ||
    (body.match(/\bOrder\s*#\s*([\d-]+)/i) || [])[1] || "";
  const dateRaw = (body.match(/Order placed\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i) || [])[1] || "";
  const totalRaw = (body.match(/Grand Total:\s*\$([\d,]+\.\d{2})/i) || [])[1] || "";
  const summaryRows = [...document.querySelectorAll(".od-line-item-row")].map((row) => ({
    label: txt(row.querySelector(".od-line-item-row-label")),
    cents: moneyCents(txt(row.querySelector(".od-line-item-row-content")))
  }));
  const summaryValue = (labelRe) => summaryRows.find((r) => labelRe.test(r.label))?.cents ?? null;
  const totalBeforeTaxCents = summaryValue(/^Total before tax:/i);
  const nonItemCents = summaryRows
    .filter((r) => /shipping|delivery fee|gift wrap|tip/i.test(r.label) && r.cents != null)
    .reduce((sum, r) => sum + r.cents, 0);

  const titleLinks = [...document.querySelectorAll('a[href*="/dp/"][href*="asin_title"]')]
    .filter((a) => txt(a));
  const seenCards = new Set();
  const items = [];

  for (const titleLink of titleLinks) {
    const card = titleLink.closest(".a-fixed-left-grid");
    if (!card || seenCards.has(card)) continue;
    seenCards.add(card);

    const shipment = card.closest(".a-fixed-right-grid-col.a-col-left");
    const shipmentText = (shipment?.innerText || "").replace(/\s+/g, " ");
    if (/\b(cancelled|canceled)\b/i.test(shipmentText)) continue;

    const unitText = txt(card.querySelector('[data-component="unitPrice"] .a-offscreen')) ||
      txt(card.querySelector('[data-component="unitPrice"] .a-price'));
    const unitAmount = moneyNumber(unitText);
    if (unitAmount == null) continue;

    const qtyText = txt(card.querySelector('[data-component="quantity"]'));
    const qtyMatch = qtyText.match(/(?:qty|quantity)\s*:?\s*(\d+)/i);
    const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
    const asin = (titleLink.getAttribute("href")?.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1] || "";

    items.push({
      name: txt(titleLink),
      qty,
      unitPrice: moneyString(unitAmount),
      productId: asin,
      fulfillment: (shipmentText.match(/^(Delivered|Shipped|Arriving|Not yet shipped)\b[^.]*/i) || [])[0] || "",
      _grossCents: Math.round(unitAmount * qty * 100)
    });
  }

  if (!orderId || !items.length) return null;
  const grossCents = items.reduce((sum, item) => sum + item._grossCents, 0);
  const targetCandidate = totalBeforeTaxCents == null ? grossCents : totalBeforeTaxCents - nonItemCents;
  const paidItemsTarget = targetCandidate >= 0 ? targetCandidate : grossCents;
  let allocatedCents = 0;
  const paidItems = items.map((item, index) => {
    const isLast = index === items.length - 1;
    const lineCents = grossCents > 0
      ? (isLast ? paidItemsTarget - allocatedCents : Math.round((paidItemsTarget * item._grossCents) / grossCents))
      : 0;
    allocatedCents += lineCents;
    const { _grossCents, ...raw } = item;
    return { ...raw, price: moneyString(lineCents / 100) };
  });
  return {
    retailer: "amazon",
    id: orderId,
    url: location.href,
    date: isoDate(dateRaw),
    total: totalRaw ? `$${totalRaw}` : "",
    items: paidItems
  };
}

// ---- supported stores (per-site selector packs) -------------------------
// Each store the extension knows how to read. Kroger is fully discovered.
// H-E-B is scaffolded — its selectors are TBD (discover via Inspect/Dump on
// heb.com's order-history pages, exactly how Kroger's were found).
const SITES = [
  {
    id: "kroger",
    label: "Kroger",
    match: (h) => h.includes("kroger.com"),
    listUrlRe: "/mypurchases/?$",
    detailPart: "/mypurchases/detail/",
    imagePart: "/mypurchases/image/",
    sel: {
      orderLinkSel: 'a[href*="/mypurchases/detail/"]',
      itemRowSel: '[data-testid^="list-style-product-card-"]',
      itemNameSel: '[class*="Product-title"], [class*="product-title"], a',
      itemPriceSel: '[data-testid="product-item-unit-price"]',
      dateSel: "",
      totalSel: ".citrus-Text--l.font-bold"
    }
  },
  {
    id: "heb",
    label: "H-E-B",
    match: (h) => h.includes("heb.com"),
    listUrlRe: "/my-account/your-orders",       // order list
    detailPart: "/my-account/order-history/",   // order detail (…/HEB<id>)
    imagePart: "",
    // H-E-B is read JSON-first from __NEXT_DATA__ (see hebDetailOrder); no CSS selectors needed.
    sel: { orderLinkSel: "", itemRowSel: "", itemNameSel: "", itemPriceSel: "", dateSel: "", totalSel: "" }
  },
  {
    id: "amazon",
    label: "Amazon",
    match: (h) => h === "amazon.com" || h.endsWith(".amazon.com"),
    listUrlRe: "(/gp/css/order-history|/your-orders/orders)",
    detailPart: "/your-orders/order-details",
    imagePart: "",
    sel: { orderLinkSel: 'a[href*="/your-orders/order-details?orderID="]', itemRowSel: "", itemNameSel: "", itemPriceSel: "", dateSel: "", totalSel: "" }
  }
];

function currentSite() {
  const h = location.hostname;
  return SITES.find((s) => s.match(h)) || null;
}

async function getCfg() {
  const site = currentSite();
  const base = site
    ? site.sel
    : { orderLinkSel: "", itemRowSel: "", itemNameSel: "", itemPriceSel: "", dateSel: "", totalSel: "" };
  const d = await api.storage.local.get("cfg");
  // Saved overrides are scoped per store so stores don't clobber each other.
  const saved = (d.cfg && site && d.cfg[site.id]) || {};
  const merged = { ...base };
  for (const k of Object.keys(base)) if (saved[k]) merged[k] = saved[k];
  // Carry site meta for scan()/collectOrderLinks (underscore = not a selector field).
  merged._site = site ? site.id : null;
  merged._listUrlRe = site ? site.listUrlRe : "";
  merged._detailPart = site ? site.detailPart : "";
  merged._imagePart = site ? site.imagePart : "";
  return merged;
}

const cleanPrice = (s) => (s || "").replace(/\s+/g, "").replace(/(\$\d+)\.?(\d{2})\b/, "$1.$2").trim();

const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

// ---- inspect: discover the page's structure ------------------------------

function inspect() {
  const embedded = readEmbeddedJson();
  const guesses = [
    'a[href*="/mypurchases/"]',
    'a[href*="order"]',
    'a[href*="receipt"]',
    '[data-testid*="order"]',
    '[class*="PurchaseCard"]',
    '[class*="order"]'
  ];
  const linkGuesses = guesses.map((sel) => ({ sel, count: document.querySelectorAll(sel).length }));
  const report = {
    url: location.href,
    hasEmbeddedJson: Object.keys(embedded).length > 0,
    embeddedKeys: Object.keys(embedded),
    embeddedShape: embedded.__NEXT_DATA__
      ? topKeys(embedded.__NEXT_DATA__.props || embedded.__NEXT_DATA__, 2)
      : null,
    linkGuesses,
    title: document.title
  };
  console.log("%c[breadcrumbs] inspect", "color:#E0A12E;font-weight:bold", report, embedded);
  return report;
}

// ---- scan: extract orders using your configured selectors ----------------

// Collect this page's order detail URLs (deduped; /image/ rewritten to /detail/ where the
// store distinguishes them). Uses the active store's URL patterns from getCfg.
function collectOrderLinks(cfg) {
  // H-E-B: order URLs come from __NEXT_DATA__, not anchors.
  if (cfg._site === "heb") {
    const nd = readNextData();
    return (nd && hebListOrders(nd)) || [];
  }
  if (cfg._site === "amazon") return amazonListOrders();
  if (!cfg.orderLinkSel) return [];
  const detail = cfg._detailPart || "";
  const image = cfg._imagePart || "";
  let links = [...document.querySelectorAll(cfg.orderLinkSel)]
    .map((a) => (a.tagName === "A" ? a.href : a.querySelector("a")?.href))
    .filter(Boolean);
  if (image && detail) links = links.map((u) => u.replace(image, detail));
  if (detail) links = links.filter((u) => u.includes(detail));
  return [...new Set(links)];
}

// Read the purchase-history pager so the deep scan can crawl every page. Reports the
// highest page number, any numbered page anchors that carry a real href (preferred —
// lets us open pages directly), and whether the current URL already uses a page param.
function readPager() {
  const nums = [];
  const pageLinks = [];
  for (const el of document.querySelectorAll("a,button")) {
    const t = (el.textContent || "").trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n > 0 && n < 1000) {
        nums.push(n);
        if (el.tagName === "A" && el.getAttribute("href")) pageLinks.push({ n, href: el.href });
      }
    }
  }
  const u = new URL(location.href);
  let pageParam = null;
  for (const k of ["page", "p", "pageNumber", "pg"]) if (u.searchParams.has(k)) { pageParam = k; break; }
  const amazon = currentSite()?.id === "amazon" ? amazonHistoryInfo() : { filterUrls: [], nextHref: "" };
  return {
    maxPage: nums.length ? Math.max(...nums) : 1,
    pageLinks,
    pageParam,
    base: location.origin + location.pathname,
    filterUrls: amazon.filterUrls,
    nextHref: amazon.nextHref
  };
}

function scan(cfg) {
  // H-E-B: read structured order data from __NEXT_DATA__ (no selectors).
  if (cfg._site === "heb") {
    const nd = readNextData();
    if (nd) {
      const listRe = cfg._listUrlRe ? new RegExp(cfg._listUrlRe) : null;
      if (listRe && listRe.test(location.pathname)) {
        const urls = hebListOrders(nd);
        if (urls && urls.length) return { page: "list", orderUrls: urls };
      }
      const order = hebDetailOrder(nd);
      if (order && order.items.length) return { page: "detail", order };
    }
    return { page: "unknown", note: "H-E-B: couldn't read order JSON here. Open your H-E-B orders list or an order's detail page." };
  }

  if (cfg._site === "amazon") {
    const onDetail = location.pathname.includes(cfg._detailPart);
    if (onDetail) {
      const order = amazonDetailOrder();
      if (order) return { page: "detail", order };
      return { page: "unknown", note: "Amazon order detail did not expose item prices here." };
    }
    const urls = amazonListOrders();
    if (urls.length) return { page: "list", orderUrls: urls };
    return { page: "unknown", note: "Open Amazon Your Orders, then gather again." };
  }

  // Only treat the page as the order LIST when its URL matches the store's list pattern
  // (not a detail page) — and only if the store has a list pattern defined yet.
  const listRe = cfg._listUrlRe ? new RegExp(cfg._listUrlRe) : null;
  const onListPage = listRe ? listRe.test(location.pathname) : false;
  if (onListPage && cfg.orderLinkSel) {
    const unique = collectOrderLinks(cfg);
    if (unique.length) return { page: "list", orderUrls: unique };
  }
// Read order-level metadata from the summary panel via resilient text regex
// (class names churn; the labels "Total:" and "Order Date" are stable).
function readOrderMeta() {
  const body = (document.body.innerText || "").replace(/\s+/g, " ");
  const total = (body.match(/\bTotal:\s*\$([\d.,]+)/) || [])[1];
  const dateM = body.match(/Order Date\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/);
  return { total: total ? "$" + total : "", date: dateM ? dateM[1].replace(/\s+/g, " ") : "" };
}

  if (cfg.itemRowSel) {
    const rows = [...document.querySelectorAll(cfg.itemRowSel)];
    const noise = /^(save to list|add to cart|buy it again|view|details?)$/i;
    const pickName = (r) => {
      const cands = cfg.itemNameSel ? [...r.querySelectorAll(cfg.itemNameSel)] : [r];
      for (const el of cands) {
        const t = txt(el);
        if (t && !noise.test(t) && t.length > 2) return t.replace(/^Save to List\s*/i, "");
      }
      return txt(r).replace(/Save to List|Add to Cart/gi, "").trim().slice(0, 80);
    };
    const items = rows.map((r) => {
      const rowText = (r.innerText || "").replace(/\s+/g, " ");
      const qty = (rowText.match(/Received:\s*(\d+)/) || [])[1];
      const paid = (rowText.match(/Paid:\s*\$?([\d.,]+)/) || [])[1];
      const unit = cleanPrice(txt(cfg.itemPriceSel ? r.querySelector(cfg.itemPriceSel) : null));
      return {
        name: pickName(r),
        qty: qty ? Number(qty) : 1,
        price: paid ? "$" + paid : unit, // "Paid" is what actually hit the card
        unitPrice: unit
      };
    }).filter((i) => i.name && i.price); // a real purchased line always has a Paid price;
    // "Out of Stock Items" cards (not included in the order) have none, so this drops them.
    const meta = readOrderMeta();
    const dateFromUrl = (location.pathname.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || "";
    const order = {
      retailer: cfg._site || "kroger",
      id: location.pathname.split("/").filter(Boolean).pop() || String(Date.now()),
      url: location.href,
      date: meta.date || dateFromUrl,
      total: meta.total,
      items
    };
    if (items.length) return { page: "detail", order };
  }
  return { page: "unknown", note: "No configured selector matched. Run Inspect and set selectors in the popup." };
}

// ---- dump: snapshot the live order structure as the content script sees it ----
// Console queries hit the top document and miss orders rendered elsewhere; the
// content script runs in the page itself, so this sees what's really there.

function dump() {
  const priceRe = /\$\d+\.\d{2}/;
  const all = [...document.querySelectorAll("*")];
  // Every data-testid present — these are the durable hooks. Highlight POT-* ones.
  const testIds = [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")))];
  const potIds = testIds.filter((t) => /^POT-/i.test(t));
  // Item-like rows: small elements that carry a data-testid and contain a price.
  const seen = new Set();
  const itemRows = [...document.querySelectorAll("[data-testid]")]
    .filter((e) => priceRe.test(e.textContent || "") && e.children.length <= 8)
    .filter((e) => { const t = e.getAttribute("data-testid"); if (seen.has(t)) return false; seen.add(t); return true; })
    .slice(0, 10)
    .map((e) => ({ testid: e.getAttribute("data-testid"), tag: e.tagName, text: (e.innerText || "").replace(/\s+/g, " ").slice(0, 90) }));
  // Fallback: bare price leaf nodes, in case line items have no testid.
  const priceLeaves = all
    .filter((e) => e.children.length === 0 && priceRe.test(e.textContent || ""))
    .slice(0, 6)
    .map((e) => ({ tag: e.tagName, cls: (e.className || "").toString().slice(0, 60), text: (e.innerText || "").replace(/\s+/g, " ").slice(0, 60) }));
  const report = { url: location.href, totalNodes: all.length, testIdCount: testIds.length, potIds, itemRows, priceLeaves };
  console.log("%c[breadcrumbs] dump", "color:#E0A12E;font-weight:bold", report, { allTestIds: testIds });
  return report;
}

// ---- message bridge ------------------------------------------------------
// sendResponse + `return true` works in both Chrome and Safari MV3.

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "INSPECT") sendResponse({ ok: true, report: inspect() });
      else if (msg.type === "DUMP") sendResponse({ ok: true, report: dump() });
      else if (msg.type === "SCAN") sendResponse({ ok: true, result: scan(await getCfg()) });
      else if (msg.type === "LIST_LINKS") sendResponse({ ok: true, orderUrls: collectOrderLinks(await getCfg()) });
      else if (msg.type === "LIST_PAGE_INFO") sendResponse({ ok: true, orderUrls: collectOrderLinks(await getCfg()), pager: readPager() });
      else if (msg.type === "PAGER_INFO") sendResponse({ ok: true, pager: readPager() });
      else if (msg.type === "WHICH_SITE") { const s = currentSite(); sendResponse({ ok: true, id: s ? s.id : null, label: s ? s.label : null }); }
      else sendResponse({ ok: false, error: "unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});
