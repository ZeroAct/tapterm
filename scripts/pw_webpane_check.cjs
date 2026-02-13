const { chromium, devices } = require('playwright');

(async () => {
  const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8056';
  const password = process.env.AUTH_PASSWORD || 'testpass';

  const iPhone = devices['iPhone 13'] || devices['iPhone 12'];
  const browser = await chromium.launch();
  const context = await browser.newContext(iPhone ? { ...iPhone } : {});
  const page = await context.newPage();

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', password);
  await page.click('#login-btn');

  await page.waitForFunction(() => {
    const o = document.getElementById('auth-overlay');
    return !!o && o.classList.contains('hidden');
  });
  await page.waitForFunction(() => {
    const b = document.getElementById('new-web');
    return !!b && !b.disabled;
  });

  // In headless runs, prompt dialogs can be flaky; override prompt directly.
  await page.evaluate(() => {
    window.prompt = () => '18080';
  });

  await page.waitForSelector('#new-web');
  await page.click('#new-web');
  await page.waitForSelector('.pane-web iframe');

  const iframeEl = page.locator('.pane-web iframe').first();
  await page.waitForTimeout(300);

  const src = await iframeEl.getAttribute('src');
  if (!src || !src.includes('/proxy/http/18080/')) throw new Error(`unexpected iframe src: ${src}`);

  const frame = page.frameLocator('.pane-web iframe').first();
  await frame.locator('text=Hello from host localhost').waitFor({ timeout: 5000 });

  console.log(JSON.stringify({ ok: true }));
  await browser.close();
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
