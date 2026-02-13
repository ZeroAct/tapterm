const { chromium, devices } = require('playwright');
const http = require('http');

async function startHello() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1 id="h">Hello Stream</h1></body></html>');
    });
    server.listen(18081, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

(async () => {
  const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8050';
  const password = process.env.AUTH_PASSWORD || 'testpass';

  const hello = await startHello();

  const iPhone = devices['iPhone 13'] || devices['iPhone 12'];
  const browser = await chromium.launch();
  const context = await browser.newContext(iPhone ? { ...iPhone } : {});
  const page = await context.newPage();

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', password);
  await page.click('#login-btn');
  await page.waitForFunction(() => document.getElementById('auth-overlay').classList.contains('hidden'));

  await page.waitForFunction(() => {
    const b = document.getElementById('new-web');
    return !!b && !b.disabled;
  });

  await page.click('#new-web');
  await page.waitForSelector('#web-overlay:not(.hidden)');
  await page.fill('#web-url', 'http://127.0.0.1:18081/');
  await page.click('#web-open');
  await page.waitForSelector('.pane-web img');

  // Wait for at least one frame.
  await page.waitForFunction(() => {
    const img = document.querySelector('.pane-web img');
    return img && typeof img.src === 'string' && img.src.startsWith('data:image/');
  }, {}, { timeout: 20000 });

  console.log(JSON.stringify({ ok: true }));

  await browser.close();
  await new Promise((r) => hello.close(r));
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
