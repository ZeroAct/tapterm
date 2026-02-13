const { chromium, devices } = require('playwright');

(async () => {
  const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8050';
  const password = process.env.AUTH_PASSWORD || 'testpass';

  const iPhone = devices['iPhone 13'] || devices['iPhone 12'];
  const browser = await chromium.launch();
  const context = await browser.newContext(iPhone ? { ...iPhone } : {});
  const page = await context.newPage();

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', password);
  await page.click('#login-btn');

  await page.waitForSelector('.shortcut-row');

  const labels = await page.$$eval('.shortcut-row .shortcut-btn', (els) => els.map((e) => e.textContent.trim()));
  const expected = ['Tab', 'Esc', 'Up', 'Dn', 'Lf', 'Rt', 'Bksp', 'Enter', 'Ctrl+C', 'Ctrl+L', 'Ctrl+D', 'Copy', 'Paste'];
  for (const k of expected) {
    if (!labels.includes(k)) throw new Error(`Missing shortcut button: ${k}`);
  }

  console.log(JSON.stringify({ ok: true, count: labels.length }));

  await browser.close();
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
