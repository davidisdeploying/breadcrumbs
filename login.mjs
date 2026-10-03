import { chromium } from 'playwright';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from './config.mjs';

// Run this ONCE (and again only if your session expires). It opens a real browser window so you
// can sign in normally and clear any MFA / CAPTCHA yourself. The logged-in session is saved into
// the persistent profile dir, which `fetch.mjs` reuses headlessly.
async function main() {
  console.log('Launching a browser window for Kroger login.');
  console.log('Sign in normally and complete any MFA / CAPTCHA yourself.');
  console.log(`Session will persist in: ${config.userDataDir}\n`);

  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page
    .goto(config.urls.signIn, { waitUntil: 'domcontentloaded', timeout: config.timeout })
    .catch(() => {});

  const rl = readline.createInterface({ input, output });
  await rl.question(
    '\nWhen you are fully logged in and can see your account, press Enter here to save the session... ',
  );
  rl.close();

  await context.close();
  console.log('\nSession saved. Next: `npm run inspect`, set your selectors in .env, then `npm run fetch`.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
