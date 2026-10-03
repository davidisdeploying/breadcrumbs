import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { notify } from './notify.mjs';

const INSPECT = process.env.INSPECT === '1';

async function loadLedger() {
  try {
    return new Set(JSON.parse(await fs.readFile(config.ledgerPath, 'utf8')));
  } catch {
    return new Set();
  }
}

async function saveLedger(set) {
  await fs.writeFile(config.ledgerPath, JSON.stringify([...set], null, 2));
}

const ensureDir = (dir) => fs.mkdir(dir, { recursive: true });

const safeName = (s) => String(s).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 90) || 'order';

// Derive a stable id from an order URL (last path segment + any id-ish query param).
function deriveId(href) {
  try {
    const u = new URL(href);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const q = u.searchParams.get('orderId') || u.searchParams.get('id') || '';
    return safeName([seg, q].filter(Boolean).join('-'));
  } catch {
    return safeName(href);
  }
}

// Lazy-loaded lists need a nudge to render every order before we read the DOM.
async function autoScroll(page, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(800);
  }
}

async function main() {
  await ensureDir(config.outputDir);
  const ledger = await loadLedger();

  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    viewport: { width: 1280, height: 900 },
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // Capture JSON responses: everything in inspect mode, only matched URLs otherwise.
  const captured = [];
  page.on('response', async (res) => {
    try {
      if (!(res.headers()['content-type'] || '').includes('application/json')) return;
      const url = res.url();
      if (INSPECT || (config.orderApiMatch && url.includes(config.orderApiMatch))) {
        captured.push({ url, status: res.status(), body: await res.text() });
      }
    } catch {
      /* response body not available — ignore */
    }
  });

  console.log(`Opening orders page: ${config.urls.orders}`);
  await page.goto(config.urls.orders, { waitUntil: 'domcontentloaded', timeout: config.timeout });
  await page.waitForTimeout(2500);
  await autoScroll(page);

  // ---- INSPECT MODE: dump everything so you can find selectors / the order API ----
  if (INSPECT) {
    await ensureDir('debug');
    await fs.writeFile(path.join('debug', 'orders.html'), await page.content());
    await page.screenshot({ path: path.join('debug', 'orders.png'), fullPage: true });
    await fs.writeFile(path.join('debug', 'network.json'), JSON.stringify(captured, null, 2));
    console.log('\nInspect complete. Wrote:');
    console.log('  debug/orders.html   — page DOM; find the <a> tags linking to each order');
    console.log('  debug/orders.png    — full screenshot to confirm you were logged in');
    console.log(`  debug/network.json  — ${captured.length} JSON responses; look for the one listing your orders`);
    console.log('\nNext: set SEL_ORDER_LINK (and ideally SEL_RECEIPT_READY) in .env, then `npm run fetch`.');
    console.log('If you were NOT logged in, re-run `npm run login`.');
    await context.close();
    return;
  }

  // ---- FETCH MODE ----
  // A redirect to the sign-in page means the saved session expired. Notify and bail with a
  // distinct exit code so the scheduler can tell "needs a human" apart from a real failure.
  if (/sign-?in|authentication|\/login/i.test(page.url())) {
    await notify('Kroger session expired', 'Run `npm run login` to refresh the saved session.');
    console.error('Session expired (redirected to sign-in). Run `npm run login`.');
    await context.close();
    process.exit(3);
  }

  if (!config.selectors.orderLink) {
    console.error('SEL_ORDER_LINK is not set. Run `npm run inspect` first, then configure .env.');
    await context.close();
    process.exit(2);
  }

  // Collect order hrefs up front so we never click stale element handles.
  const links = await page.locator(config.selectors.orderLink).evaluateAll((els) =>
    els
      .map((e) => (e.tagName === 'A' ? e.href : e.querySelector('a')?.href))
      .filter(Boolean),
  );
  const unique = [...new Set(links)];
  console.log(`Found ${unique.length} order link(s).`);

  let newCount = 0;
  for (const href of unique) {
    const orderId = deriveId(href);
    if (ledger.has(orderId)) continue;

    try {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: config.timeout });
      if (config.selectors.receiptReady) {
        await page.locator(config.selectors.receiptReady).first().waitFor({ timeout: config.timeout });
      } else {
        await page.waitForTimeout(2500);
      }
      await autoScroll(page, 4);

      const pngPath = path.join(config.outputDir, `${orderId}.png`);
      await page.screenshot({ path: pngPath, fullPage: true });
      console.log(`Saved receipt: ${pngPath}`);

      if (config.savePdf && config.headless) {
        const pdfPath = path.join(config.outputDir, `${orderId}.pdf`);
        await page.emulateMedia({ media: 'print' });
        await page.pdf({ path: pdfPath, printBackground: true });
        await page.emulateMedia({ media: 'screen' });
        console.log(`Saved PDF:     ${pdfPath}`);
      } else if (config.savePdf && !config.headless) {
        console.warn('SAVE_PDF is set but PDF export needs HEADLESS=true; saved PNG only.');
      }

      ledger.add(orderId);
      newCount++;
    } catch (err) {
      console.warn(`Skipped ${orderId}: ${err.message}`);
    }
  }

  await saveLedger(ledger);

  if (config.orderApiMatch && captured.length) {
    await fs.writeFile(
      path.join(config.outputDir, 'orders-api.json'),
      JSON.stringify(captured, null, 2),
    );
    console.log(`Also saved ${captured.length} matched API response(s) to orders-api.json`);
  }

  console.log(`Done. ${newCount} new receipt(s) in ${config.outputDir}.`);
  if (newCount > 0) {
    await notify('Kroger receipts ready', `${newCount} new receipt(s) saved to ${config.outputDir}.`);
  }
  await context.close();
}

main().catch(async (err) => {
  console.error(err);
  await notify('Kroger fetcher failed', String(err?.message || err));
  process.exit(1);
});
