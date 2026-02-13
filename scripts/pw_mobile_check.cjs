const { chromium, devices } = require('playwright');

(async () => {
  const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8050';
  const password = process.env.AUTH_PASSWORD || 'testpass';

  const iPhone = devices['iPhone 13'] || devices['iPhone 12'];
  if (!iPhone) throw new Error('No iPhone device descriptor available');

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...iPhone });
  const page = await context.newPage();

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', password);
  await page.click('#login-btn');
  await page.waitForSelector('.pane-term .xterm');

  await page.click('#split-v');
  await page.waitForSelector('.splitter.row');

  const firstBefore = await page.locator('.split-child').first().boundingBox();
  if (!firstBefore) throw new Error('No first split-child box');

  const splitter = page.locator('.splitter.row').first();
  const sb = await splitter.boundingBox();
  if (!sb) throw new Error('No splitter box');

  // Drag splitter to change ratio.
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 120, sb.y + sb.height / 2, { steps: 10 });
  await page.mouse.up();

  const firstAfter = await page.locator('.split-child').first().boundingBox();
  if (!firstAfter) throw new Error('No first split-child box after drag');

  const widthDelta = Math.round(firstAfter.width - firstBefore.width);

  // Tap into the terminal area.
  await page.tap('.pane-term');

  console.log(JSON.stringify({ ok: true, widthDelta }));

  await browser.close();
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
