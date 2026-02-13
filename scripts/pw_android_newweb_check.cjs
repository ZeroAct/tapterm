const { chromium, devices } = require('playwright');

(async () => {
  const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8050';
  const password = process.env.AUTH_PASSWORD || 'testpass';

  const device = devices['Pixel 5'] || devices['Pixel 7'] || null;
  const browser = await chromium.launch();
  const context = await browser.newContext(device ? { ...device } : {});
  const page = await context.newPage();

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', password);
  await page.click('#login-btn');
  await page.waitForFunction(() => document.getElementById('auth-overlay').classList.contains('hidden'));

  await page.click('#new-web');
  await page.waitForSelector('#web-overlay:not(.hidden)');
  await page.fill('#web-url', 'https://example.com/');
  await page.click('#web-open');

  await page.waitForSelector('.pane-web img');
  await page.waitForFunction(() => {
    const img = document.querySelector('.pane-web img');
    return img && img.src && img.src.startsWith('data:image/');
  }, {}, { timeout: 20000 });

  console.log(JSON.stringify({ ok: true }));
  await browser.close();
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
