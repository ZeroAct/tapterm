const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8049);
const WORKDIR = process.env.WORKDIR || process.cwd();
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || '');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const SHELL = process.env.TERMINAL_SHELL || process.env.SHELL || '/bin/bash';
const TERM_DEFAULT_COLS = Number(process.env.TERM_COLS || 120);
const TERM_DEFAULT_ROWS = Number(process.env.TERM_ROWS || 32);
const TERM_BUFFER_MAX_CHARS = Number(process.env.TERM_BUFFER_MAX_CHARS || 200000);
const WEB_MAX_SESSIONS = Number(process.env.WEB_MAX_SESSIONS || 6);
const WEB_FPS = Number(process.env.WEB_FPS || 8);
const WEB_JPEG_QUALITY = Number(process.env.WEB_JPEG_QUALITY || 70);

const PUBLIC_DIR = path.join(__dirname, 'public');
const XTERM_JS = path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js');
const XTERM_CSS = path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
const XTERM_FIT_JS = path.join(__dirname, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js');

const authSessions = new Map();
const terminals = new Map();
const webSessions = new Map();
let workspaceState = {
  tabs: [],
  activeTabId: '',
  activeTerminalId: '',
  activeLeaf: null,
  updatedAt: nowIso(),
};

if (!AUTH_PASSWORD) {
  // eslint-disable-next-line no-console
  console.error('AUTH_PASSWORD is required. Refusing to start.');
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return proto === 'https';
}

function createAuthSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  authSessions.set(token, { expiresAt });
  return { token, expiresAt };
}

function deleteAuthSession(token) {
  if (token) authSessions.delete(token);
}

function getAuthSession(req) {
  const token = parseCookies(req).cwt_session;
  if (!token) return null;
  const sess = authSessions.get(token);
  if (!sess) return null;
  if (sess.expiresAt <= Date.now()) {
    authSessions.delete(token);
    return null;
  }
  return { token, expiresAt: sess.expiresAt };
}

function requireAuth(req, res) {
  const session = getAuthSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return null;
  }
  return session;
}

function makeSessionCookie(req, token, expiresAt) {
  const maxAgeSec = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  const parts = [
    `cwt_session=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req) {
  const parts = ['cwt_session=', 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of authSessions.entries()) {
    if (!session || session.expiresAt <= now) authSessions.delete(token);
  }
}

function sendFile(res, targetPath, contentType) {
  fs.readFile(targetPath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
    });
    res.end(data);
  });
}

function serveStatic(req, res) {
  let target = req.url === '/' ? '/index.html' : req.url;
  target = decodeURIComponent(target.split('?')[0]);

  if (target.includes('..')) {
    sendJson(res, 400, { ok: false, error: 'Invalid path' });
    return;
  }

  if (target === '/vendor/xterm.js') return sendFile(res, XTERM_JS, 'application/javascript; charset=utf-8');
  if (target === '/vendor/xterm.css') return sendFile(res, XTERM_CSS, 'text/css; charset=utf-8');
  if (target === '/vendor/addon-fit.js') return sendFile(res, XTERM_FIT_JS, 'application/javascript; charset=utf-8');

  const fullPath = path.join(PUBLIC_DIR, target);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 400, { ok: false, error: 'Invalid path' });
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    let contentType = 'text/plain; charset=utf-8';
    if (target.endsWith('.html')) contentType = 'text/html; charset=utf-8';
    if (target.endsWith('.css')) contentType = 'text/css; charset=utf-8';
    if (target.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function spawnTerminal() {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    COLUMNS: String(TERM_DEFAULT_COLS),
    LINES: String(TERM_DEFAULT_ROWS),
  };

  const safeShell = SHELL.replace(/(["\\$`])/g, '\\$1');
  const shellCommand = `stty cols ${TERM_DEFAULT_COLS} rows ${TERM_DEFAULT_ROWS}; exec "${safeShell}" -il`;

  return spawn('script', ['-qf', '-c', shellCommand, '/dev/null'], {
    cwd: WORKDIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function terminalSummary(term) {
  return {
    id: term.id,
    title: term.title,
    createdAt: term.createdAt,
    updatedAt: term.updatedAt,
    status: term.status,
    exitCode: term.exitCode,
    exitSignal: term.exitSignal,
    attachedClients: term.clients.size,
  };
}

function broadcast(term, payload) {
  const text = JSON.stringify(payload);
  for (const ws of term.clients) {
    if (ws.readyState === 1) ws.send(text);
  }
}

function appendOutput(term, data) {
  term.outputBuffer += data;
  if (term.outputBuffer.length > TERM_BUFFER_MAX_CHARS) {
    term.outputBuffer = term.outputBuffer.slice(-TERM_BUFFER_MAX_CHARS);
  }
  term.updatedAt = nowIso();
}

function createTerminal(options = {}) {
  const proc = spawnTerminal();
  const id = crypto.randomUUID();
  const title = String(options.title || `terminal-${id.slice(0, 8)}`);
  const term = {
    id,
    title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'running',
    exitCode: null,
    exitSignal: null,
    proc,
    clients: new Set(),
    outputBuffer: '',
    exitedPromise: null,
    markExited: null,
  };

  term.exitedPromise = new Promise((resolve) => {
    term.markExited = resolve;
  });

  terminals.set(id, term);

  proc.stdout.on('data', (chunk) => {
    const data = chunk.toString('utf8');
    appendOutput(term, data);
    broadcast(term, { type: 'output', data });
  });

  proc.stderr.on('data', (chunk) => {
    const data = chunk.toString('utf8');
    appendOutput(term, data);
    broadcast(term, { type: 'output', data });
  });

  proc.on('close', (code, signal) => {
    term.status = 'exited';
    term.exitCode = code;
    term.exitSignal = signal;
    term.updatedAt = nowIso();
    term.markExited();
    broadcast(term, { type: 'exit', code, signal });
  });

  proc.on('error', (err) => {
    const data = `\r\n[terminal error] ${err.message}\r\n`;
    appendOutput(term, data);
    broadcast(term, { type: 'output', data });
  });

  return term;
}

function listTerminals() {
  return [...terminals.values()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(terminalSummary);
}

function parseJsonSafe(input) {
  try {
    return JSON.parse(input || '{}');
  } catch {
    return {};
  }
}

function sanitizeWorkspaceNode(node) {
  if (!node || typeof node !== 'object') return null;

  if (node.kind === 'leaf') {
    const type = String(node.type || '').trim() || 'terminal';

    if (type === 'terminal') {
      const terminalId = String(node.terminalId || '').trim();
      if (!terminalId) return null;
      const title = String(node.title || '').slice(0, 120);
      return { kind: 'leaf', type: 'terminal', terminalId, title };
    }

    if (type === 'web') {
      const webIn = node.web && typeof node.web === 'object' ? node.web : {};
      const portRaw = Number(webIn.port);
      const port = Number.isFinite(portRaw) ? Math.trunc(portRaw) : 0;
      if (port < 1 || port > 65535) return null;
      const path = String(webIn.path || '/').slice(0, 2048);
      const title = String(node.title || '').slice(0, 120);
      return { kind: 'leaf', type: 'web', web: { port, path }, title };
    }

    if (type === 'browser') {
      const url = String(node.url || '').slice(0, 2048);
      if (!url) return null;
      const title = String(node.title || '').slice(0, 120);
      return { kind: 'leaf', type: 'browser', url, title };
    }

    return null;
  }

  if (node.kind === 'split') {
    const direction = node.direction === 'column' ? 'column' : 'row';
    const ratioRaw = Number(node.ratio);
    const ratio = Number.isFinite(ratioRaw) ? Math.min(0.9, Math.max(0.1, ratioRaw)) : 0.5;
    const a = sanitizeWorkspaceNode(node.a);
    const b = sanitizeWorkspaceNode(node.b);
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    return { kind: 'split', direction, ratio, a, b };
  }

  return null;
}

function sanitizeWorkspace(input) {
  const tabsIn = Array.isArray(input && input.tabs) ? input.tabs : [];
  const tabs = [];

  for (const tab of tabsIn) {
    const id = String(tab && tab.id ? tab.id : '').trim() || crypto.randomUUID();
    const title = String(tab && tab.title ? tab.title : `Tab ${tabs.length + 1}`).slice(0, 120);
    const root = sanitizeWorkspaceNode(tab && tab.root);
    if (!root) continue;
    tabs.push({ id, title, root });
  }

  const activeTabIdRaw = String(input && input.activeTabId ? input.activeTabId : '').trim();
  const activeTerminalId = String(input && input.activeTerminalId ? input.activeTerminalId : '').trim();
  const activeTabId = tabs.some((t) => t.id === activeTabIdRaw) ? activeTabIdRaw : (tabs[0] ? tabs[0].id : '');

  let activeLeaf = null;
  if (input && typeof input.activeLeaf === 'object' && input.activeLeaf) {
    const t = String(input.activeLeaf.type || '').trim();
    if (t === 'terminal') {
      const terminalId = String(input.activeLeaf.terminalId || '').trim();
      if (terminalId) activeLeaf = { type: 'terminal', terminalId };
    } else if (t === 'web') {
      const w = input.activeLeaf.web && typeof input.activeLeaf.web === 'object' ? input.activeLeaf.web : {};
      const portRaw = Number(w.port);
      const port = Number.isFinite(portRaw) ? Math.trunc(portRaw) : 0;
      if (port >= 1 && port <= 65535) {
        const path = String(w.path || '/').slice(0, 2048);
        activeLeaf = { type: 'web', web: { port, path } };
      }
    } else if (t === 'browser') {
      const url = String(input.activeLeaf.url || '').slice(0, 2048);
      if (url) activeLeaf = { type: 'browser', url };
    }
  }

  return {
    tabs,
    activeTabId,
    activeTerminalId,
    activeLeaf,
    updatedAt: nowIso(),
  };
}

function canUpgradeToTerminal(req) {
  const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (urlObj.pathname !== '/ws/terminal') return false;
  if (!urlObj.searchParams.get('terminalId')) return false;
  return !!getAuthSession(req);
}

function canUpgradeToWeb(req) {
  const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (urlObj.pathname !== '/ws/web') return false;
  if (!urlObj.searchParams.get('sessionId')) return false;
  return !!getAuthSession(req);
}

let sharedBrowser = null;
let sharedBrowserStarting = null;

async function getBrowser() {
  if (sharedBrowser) return sharedBrowser;
  if (sharedBrowserStarting) return sharedBrowserStarting;
  sharedBrowserStarting = (async () => {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
    sharedBrowser = browser;
    sharedBrowserStarting = null;
    return browser;
  })();
  return sharedBrowserStarting;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function createWebSession() {
  if (webSessions.size >= WEB_MAX_SESSIONS) {
    throw new Error(`Too many web sessions (max ${WEB_MAX_SESSIONS})`);
  }

  const id = crypto.randomUUID();
  const sess = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    url: 'about:blank',
    width: 900,
    height: 600,
    browser: null,
    context: null,
    page: null,
    clients: new Set(),
    streamingTimer: null,
    streaming: false,
    lastFrameAt: 0,
    pendingFrame: false,
    closed: false,
  };
  webSessions.set(id, sess);
  return sess;
}

async function ensureWebSessionStarted(sess) {
  if (sess.closed) throw new Error('Session closed');
  if (sess.page) return;
  const browser = await getBrowser();
  sess.browser = browser;
  sess.context = await browser.newContext({
    viewport: { width: sess.width, height: sess.height },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
  });
  sess.page = await sess.context.newPage();
  sess.page.on('close', () => {
    sess.closed = true;
  });
  // Avoid streaming unbounded console noise; clients can still see pages.
  sess.page.on('pageerror', () => {});
}

async function closeWebSession(sess) {
  if (!sess || sess.closed) return;
  sess.closed = true;
  if (sess.streamingTimer) {
    clearInterval(sess.streamingTimer);
    sess.streamingTimer = null;
  }
  try {
    if (sess.context) await sess.context.close();
  } catch {
    // ignored
  }
  sess.context = null;
  sess.page = null;
  webSessions.delete(sess.id);
}

function broadcastWeb(sess, payload) {
  const text = JSON.stringify(payload);
  for (const ws of sess.clients) {
    if (ws.readyState === 1) ws.send(text);
  }
}

async function sendWebFrame(sess, reason) {
  if (!sess || sess.closed) return;
  if (!sess.page) return;
  if (sess.clients.size === 0) return;
  if (sess.pendingFrame) return;

  const now = Date.now();
  const minInterval = WEB_FPS > 0 ? Math.floor(1000 / WEB_FPS) : 150;
  if (now - sess.lastFrameAt < minInterval) return;

  sess.pendingFrame = true;
  try {
    const jpg = await sess.page.screenshot({ type: 'jpeg', quality: clamp(WEB_JPEG_QUALITY, 30, 90) });
    sess.lastFrameAt = Date.now();
    sess.updatedAt = nowIso();
    broadcastWeb(sess, {
      type: 'frame',
      format: 'jpeg',
      data: jpg.toString('base64'),
      width: sess.width,
      height: sess.height,
      reason: reason || 'tick',
    });
  } catch (err) {
    broadcastWeb(sess, { type: 'error', error: `Screenshot failed: ${err.message}` });
  } finally {
    sess.pendingFrame = false;
  }
}

function ensureWebStreaming(sess) {
  if (!sess || sess.streamingTimer) return;
  sess.streamingTimer = setInterval(() => {
    sendWebFrame(sess, 'tick').catch(() => {});
  }, Math.max(60, Math.floor(1000 / Math.max(1, WEB_FPS))));
  sess.streamingTimer.unref();
}

setInterval(cleanupSessions, 5 * 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  try {
    // Ensure auth cookie isn't cached or served from back-forward caches.
    res.setHeader('Cache-Control', 'no-store');
    const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'codex-web-terminal',
        port: PORT,
        workdir: WORKDIR,
        authRequired: true,
        shell: SHELL,
        terminals: terminals.size,
        workspaceTabs: workspaceState.tabs.length,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/auth/status') {
      sendJson(res, 200, { ok: true, authenticated: !!getAuthSession(req) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = parseJsonSafe(await readBody(req));
      const password = String(body.password || '');

      if (!safeEqual(password, AUTH_PASSWORD)) {
        sendJson(res, 401, { ok: false, error: 'Invalid credentials' });
        return;
      }

      const session = createAuthSession();
      sendJson(
        res,
        200,
        { ok: true, authenticated: true },
        { 'Set-Cookie': makeSessionCookie(req, session.token, session.expiresAt) }
      );
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const session = getAuthSession(req);
      if (session) deleteAuthSession(session.token);
      sendJson(res, 200, { ok: true, authenticated: false }, { 'Set-Cookie': clearSessionCookie(req) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/terminal/config') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, { ok: true, shell: SHELL, wsPath: '/ws/terminal', webWsPath: '/ws/web' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/workspace') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, { ok: true, workspace: workspaceState });
      return;
    }

    if (req.method === 'PUT' && pathname === '/api/workspace') {
      if (!requireAuth(req, res)) return;
      const body = parseJsonSafe(await readBody(req));
      const next = sanitizeWorkspace(body && body.workspace ? body.workspace : body);
      workspaceState = next;
      sendJson(res, 200, { ok: true, workspace: workspaceState });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/terminals') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, { ok: true, terminals: listTerminals() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/terminals') {
      if (!requireAuth(req, res)) return;
      const body = parseJsonSafe(await readBody(req));
      const term = createTerminal({ title: String(body.title || '').trim() || undefined });
      sendJson(res, 200, { ok: true, terminal: terminalSummary(term) });
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/terminals/') && pathname.endsWith('/exit')) {
      if (!requireAuth(req, res)) return;
      const id = pathname.slice('/api/terminals/'.length, -('/exit'.length));
      const term = terminals.get(id);
      if (!term) {
        sendJson(res, 404, { ok: false, error: 'Terminal not found' });
        return;
      }

      if (term.status === 'running') {
        term.proc.kill('SIGKILL');
        await Promise.race([
          term.exitedPromise,
          new Promise((resolve) => setTimeout(resolve, 700)),
        ]);
      }

      sendJson(res, 200, { ok: true, terminal: terminalSummary(term) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/web/sessions') {
      if (!requireAuth(req, res)) return;
      const body = parseJsonSafe(await readBody(req));
      const url = String(body && body.url ? body.url : '').slice(0, 2048) || 'about:blank';
      const width = clamp(body && body.width, 240, 1920);
      const height = clamp(body && body.height, 180, 1200);

      let sess;
      try {
        sess = createWebSession();
      } catch (err) {
        sendJson(res, 429, { ok: false, error: err.message });
        return;
      }

      sess.width = Math.trunc(width);
      sess.height = Math.trunc(height);
      sess.url = url;

      sendJson(res, 200, {
        ok: true,
        session: { id: sess.id, url: sess.url, width: sess.width, height: sess.height },
      });
      return;
    }

    if (pathname.startsWith('/proxy/http/')) {
      if (!requireAuth(req, res)) return;

      const parts = pathname.split('/');
      // ['', 'proxy', 'http', '<port>', ...pathParts]
      const portStr = parts[3] || '';
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        sendJson(res, 400, { ok: false, error: 'Invalid proxy port' });
        return;
      }

      const targetHost = '127.0.0.1';
      const targetPathRaw = '/' + parts.slice(4).join('/');
      const targetPath = targetPathRaw === '/' ? '/' : targetPathRaw;
      const fullPath = `${targetPath}${urlObj.search || ''}`;

      const hopByHop = new Set([
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
      ]);

      const headers = {};
      for (const [k, v] of Object.entries(req.headers || {})) {
        const key = String(k).toLowerCase();
        if (hopByHop.has(key)) continue;
        if (key === 'host') continue;
        headers[key] = v;
      }
      headers.host = `${targetHost}:${port}`;

      const proxyReq = http.request(
        {
          host: targetHost,
          port,
          method: req.method,
          path: fullPath,
          headers,
        },
        (proxyRes) => {
          const outHeaders = { ...proxyRes.headers };
          // Allow embedding and reduce surprising policy interactions.
          delete outHeaders['x-frame-options'];
          delete outHeaders['content-security-policy'];
          delete outHeaders['content-security-policy-report-only'];

          // Make sandboxed iframe fetches a bit more likely to work ("Origin: null").
          outHeaders['access-control-allow-origin'] = 'null';
          outHeaders['access-control-allow-credentials'] = 'true';

          // Rewrite redirects back into the proxy namespace.
          const loc = outHeaders.location;
          if (typeof loc === 'string') {
            try {
              const u = new URL(loc, `http://${targetHost}:${port}${targetPath}`);
              const isLocal = (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && String(u.port || port) === String(port);
              if (isLocal) {
                outHeaders.location = `/proxy/http/${port}${u.pathname}${u.search}${u.hash}`;
              }
            } catch {
              // ignore
            }
          }

          res.writeHead(proxyRes.statusCode || 200, outHeaders);
          proxyRes.pipe(res);
        },
      );

      proxyReq.on('error', (err) => {
        sendJson(res, 502, { ok: false, error: `Proxy error: ${err.message}` });
      });

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': 'null',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
          'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || '*'),
          'Access-Control-Max-Age': '600',
        });
        res.end();
        proxyReq.destroy();
        return;
      }

      req.pipe(proxyReq);
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : 'Internal error') });
  }
});

const wss = new WebSocketServer({ noServer: true });

function handleTerminalWs(ws, req) {
  const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const terminalId = urlObj.searchParams.get('terminalId');
  const term = terminalId ? terminals.get(terminalId) : null;

  if (!term) {
    ws.send(JSON.stringify({ type: 'error', error: 'Terminal not found' }));
    ws.close(1008, 'Terminal not found');
    return;
  }

  term.clients.add(ws);
  ws.send(JSON.stringify({ type: 'ready', terminalId: term.id, status: term.status }));
  if (term.outputBuffer) ws.send(JSON.stringify({ type: 'output', data: term.outputBuffer }));
  if (term.status !== 'running') {
    ws.send(JSON.stringify({ type: 'exit', code: term.exitCode, signal: term.exitSignal }));
  }

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message.type === 'input' && typeof message.data === 'string' && term.status === 'running') {
      term.proc.stdin.write(message.data);
      return;
    }

    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    term.clients.delete(ws);
  });

  ws.on('error', () => {
    term.clients.delete(ws);
  });
}

function handleWebWs(ws, req) {
  const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const sessionId = urlObj.searchParams.get('sessionId');
  const sess = sessionId ? webSessions.get(sessionId) : null;

  if (!sess) {
    ws.send(JSON.stringify({ type: 'error', error: 'Web session not found' }));
    ws.close(1008, 'Web session not found');
    return;
  }

  sess.clients.add(ws);
  ensureWebSessionStarted(sess)
    .then(async () => {
      ws.send(JSON.stringify({ type: 'ready', sessionId: sess.id, url: sess.url, width: sess.width, height: sess.height }));
      if (sess.url && sess.url !== 'about:blank') {
        try {
          await sess.page.goto(sess.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: `Navigation failed: ${err.message}` }));
        }
      }
      ensureWebStreaming(sess);
      await sendWebFrame(sess, 'ready');
    })
    .catch((err) => {
      ws.send(JSON.stringify({ type: 'error', error: `Web session start failed: ${err.message}` }));
    });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (!sess.page) return;

    if (msg.type === 'nav') {
      const url = String(msg.url || '').slice(0, 2048);
      if (!url) return;
      sess.url = url;
      sess.updatedAt = nowIso();
      try {
        await sess.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: `Navigation failed: ${err.message}` }));
      }
      sendWebFrame(sess, 'nav').catch(() => {});
      return;
    }

    if (msg.type === 'resize') {
      const width = Math.trunc(clamp(msg.width, 240, 1920));
      const height = Math.trunc(clamp(msg.height, 180, 1200));
      sess.width = width;
      sess.height = height;
      sess.updatedAt = nowIso();
      try {
        await sess.page.setViewportSize({ width, height });
      } catch {
        // ignored
      }
      sendWebFrame(sess, 'resize').catch(() => {});
      return;
    }

    if (msg.type === 'input') {
      const e = msg.event && typeof msg.event === 'object' ? msg.event : {};
      const kind = String(e.kind || '');

      try {
        if (kind === 'mousemove') {
          await sess.page.mouse.move(Number(e.x || 0), Number(e.y || 0));
        } else if (kind === 'mousedown') {
          await sess.page.mouse.move(Number(e.x || 0), Number(e.y || 0));
          await sess.page.mouse.down({ button: e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left' });
        } else if (kind === 'mouseup') {
          await sess.page.mouse.move(Number(e.x || 0), Number(e.y || 0));
          await sess.page.mouse.up({ button: e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left' });
        } else if (kind === 'wheel') {
          await sess.page.mouse.wheel(Number(e.dx || 0), Number(e.dy || 0));
        } else if (kind === 'key') {
          const action = String(e.action || 'down');
          const key = String(e.key || '');
          if (!key) return;
          if (action === 'down') await sess.page.keyboard.down(key);
          else if (action === 'up') await sess.page.keyboard.up(key);
          else if (action === 'press') await sess.page.keyboard.press(key);
        } else if (kind === 'text') {
          const text = String(e.text || '');
          if (text) await sess.page.keyboard.insertText(text);
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: `Input failed: ${err.message}` }));
      }

      sendWebFrame(sess, 'input').catch(() => {});
    }
  });

  ws.on('close', () => {
    sess.clients.delete(ws);
    if (sess.clients.size === 0) {
      // Keep it alive briefly; if it stays unused it will be GC'd by max sessions pressure.
      // (Simple approach: close on last disconnect after a delay.)
      setTimeout(() => {
        const s = webSessions.get(sess.id);
        if (!s) return;
        if (s.clients.size > 0) return;
        closeWebSession(s).catch(() => {});
      }, 30_000).unref();
    }
  });

  ws.on('error', () => {
    sess.clients.delete(ws);
  });
}

wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (urlObj.pathname === '/ws/web') return handleWebWs(ws, req);
  return handleTerminalWs(ws, req);
});

server.on('upgrade', (req, socket, head) => {
  if (!(canUpgradeToTerminal(req) || canUpgradeToWeb(req))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`codex-web-terminal listening on http://${HOST}:${PORT}`);
});
