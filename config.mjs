import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

// All knobs in one place. Everything is overridable via .env (see .env.example).
export const config = {
  // Where fetched receipt images/PDFs are written (point Monarch at this, or batch-upload from here)
  outputDir: process.env.OUTPUT_DIR || './receipts',

  // Persistent browser profile dir. Keeps you logged into Kroger across runs.
  // Created on first `npm run login`; reused by every `npm run fetch`.
  userDataDir: process.env.USER_DATA_DIR || path.join(os.homedir(), '.local', 'state', 'breadcrumbs', 'browser-profile'),

  // Ledger of order ids already fetched, so cron runs only grab NEW receipts.
  ledgerPath: process.env.LEDGER_PATH || './seen.json',

  // Headless for unattended runs. Login is always headed (you handle MFA/CAPTCHA).
  // If Kroger challenges headless runs, set HEADLESS=false and use a virtual display (see README).
  headless: process.env.HEADLESS !== 'false',

  // Also render each receipt to PDF (Chromium PDF works in HEADLESS mode only).
  savePdf: process.env.SAVE_PDF === 'true',

  // Optional explicit UA. Leave unset to use Chromium's default (recommended — a mismatched
  // UA can make automation MORE detectable, not less).
  userAgent: process.env.USER_AGENT || undefined,

  // Kroger URLs. VERIFY against your own account — banners/regions differ.
  urls: {
    signIn: process.env.SIGNIN_URL || 'https://www.kroger.com/signin',
    orders: process.env.ORDERS_URL || 'https://www.kroger.com/mypurchases',
  },

  // Selectors — discover these with `npm run inspect`, then set them in .env.
  selectors: {
    // Anchor (<a>) elements that link to each order's detail/receipt page.
    // The fetcher collects their hrefs and visits each directly (no fragile back-navigation).
    orderLink: process.env.SEL_ORDER_LINK || '',
    // An element that confirms the receipt/detail page has finished loading.
    receiptReady: process.env.SEL_RECEIPT_READY || '',
  },

  // Optional: if you'd rather capture Kroger's underlying JSON than screenshots, set this to a
  // substring of the order API URL you spotted in `debug/network.json`. Matched responses are
  // dumped to <outputDir>/orders-api.json alongside the images.
  orderApiMatch: process.env.ORDER_API_MATCH || '',

  // Optional: POST a notification here when new receipts arrive, the session expires, or a run
  // fails. ntfy-style by default (plain-text body + Title header) — e.g. https://ntfy.sh/your-topic
  // or your self-hosted ntfy. Leave blank to disable.
  notifyWebhook: process.env.NOTIFY_WEBHOOK || '',

  // Navigation / element timeout (ms)
  timeout: Number(process.env.TIMEOUT_MS || 30000),
};
