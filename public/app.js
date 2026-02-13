const overlayEl = document.getElementById('auth-overlay');
const loginFormEl = document.getElementById('login-form');
const passwordEl = document.getElementById('password');
const authErrorEl = document.getElementById('auth-error');

const webOverlayEl = document.getElementById('web-overlay');
const webFormEl = document.getElementById('web-form');
const webUrlEl = document.getElementById('web-url');
const webCancelEl = document.getElementById('web-cancel');
const webErrorEl = document.getElementById('web-error');

const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const tabbarEl = document.getElementById('tabbar');
const workspaceEl = document.getElementById('workspace');

const newTabEl = document.getElementById('new-tab');
const newWebEl = document.getElementById('new-web');
const splitVEl = document.getElementById('split-v');
const splitHEl = document.getElementById('split-h');
const exitTerminalEl = document.getElementById('exit-terminal');
const refreshEl = document.getElementById('refresh');
const logoutEl = document.getElementById('logout');

const state = {
  authenticated: false,
  shell: '',
  wsPath: '/ws/terminal',
  webWsPath: '/ws/web',
  tabs: [],
  activeTabId: '',
  activePaneId: '',
  panes: new Map(),
  runtimes: new Map(),
  saveTimer: null,
};

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const SHORTCUT_ORDER_KEY = 'cwt_shortcut_order_v1';
const SHORTCUTS = [
  { key: 'tab', label: 'Tab', title: 'Tab', kind: 'send', data: '\t' },
  { key: 'esc', label: 'Esc', title: 'Escape', kind: 'send', data: '\x1b' },
  { key: 'up', label: 'Up', title: 'Arrow Up', kind: 'send', data: '\x1b[A' },
  { key: 'dn', label: 'Dn', title: 'Arrow Down', kind: 'send', data: '\x1b[B' },
  { key: 'lf', label: 'Lf', title: 'Arrow Left', kind: 'send', data: '\x1b[D' },
  { key: 'rt', label: 'Rt', title: 'Arrow Right', kind: 'send', data: '\x1b[C' },
  { key: 'bksp', label: 'Bksp', title: 'Backspace', kind: 'send', data: '\x7f' },
  { key: 'enter', label: 'Enter', title: 'Enter', kind: 'send', data: '\r' },
  { key: 'ctrlc', label: 'Ctrl+C', title: 'Interrupt (SIGINT)', kind: 'send', data: '\x03' },
  { key: 'ctrll', label: 'Ctrl+L', title: 'Clear screen', kind: 'send', data: '\x0c' },
  { key: 'ctrld', label: 'Ctrl+D', title: 'EOF', kind: 'send', data: '\x04' },
  { key: 'copy', label: 'Copy', title: 'Copy selection', kind: 'copy' },
  { key: 'paste', label: 'Paste', title: 'Paste', kind: 'paste' },
];

const SHORTCUTS_BY_KEY = new Map(SHORTCUTS.map((s) => [s.key, s]));

function loadShortcutOrder() {
  try {
    const raw = localStorage.getItem(SHORTCUT_ORDER_KEY);
    if (!raw) return SHORTCUTS.map((s) => s.key);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return SHORTCUTS.map((s) => s.key);
    const out = [];
    const seen = new Set();
    for (const k of parsed) {
      const key = String(k || '').trim();
      if (!key || seen.has(key)) continue;
      if (!SHORTCUTS_BY_KEY.has(key)) continue;
      out.push(key);
      seen.add(key);
    }
    for (const s of SHORTCUTS) {
      if (!seen.has(s.key)) out.push(s.key);
    }
    return out;
  } catch {
    return SHORTCUTS.map((s) => s.key);
  }
}

function saveShortcutOrder(keys) {
  try {
    localStorage.setItem(SHORTCUT_ORDER_KEY, JSON.stringify(keys));
  } catch {
    // ignore
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setMeta(text) {
  metaEl.textContent = text;
}

function setAuthenticated(value) {
  state.authenticated = value;
  overlayEl.classList.toggle('hidden', value);
  webOverlayEl.classList.add('hidden');
  const enabled = value;
  newTabEl.disabled = !enabled;
  newWebEl.disabled = !enabled;
  splitVEl.disabled = !enabled;
  splitHEl.disabled = !enabled;
  refreshEl.disabled = !enabled;
  logoutEl.disabled = !enabled;
  exitTerminalEl.disabled = !enabled;
}

function openWebOverlay(defaultUrl) {
  if (!state.authenticated) return;
  webErrorEl.textContent = '';
  webOverlayEl.classList.remove('hidden');
  const url = normalizeAnyUrl(defaultUrl) || String(defaultUrl || '').trim() || 'https://google.com/';
  webUrlEl.value = url;
  requestAnimationFrame(() => webUrlEl.focus());
}

function closeWebOverlay() {
  webOverlayEl.classList.add('hidden');
  webErrorEl.textContent = '';
}

function socketUrl(pathname) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${pathname}`;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function putJson(url, payload) {
  const res = await fetch(url, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'include' });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function sendInput(runtime, data) {
  if (!runtime || typeof data !== 'string' || data.length === 0) return;
  if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return;
  runtime.socket.send(JSON.stringify({ type: 'input', data }));
}

async function copyText(text) {
  const value = String(text || '');
  if (!value) return { ok: false, error: 'Nothing to copy' };

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return { ok: true };
    }
  } catch {
    // fall through to legacy fallback
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (ok) return { ok: true };
  } catch {
    // ignored
  }

  // Last resort: show it so the user can copy manually.
  window.prompt('Copy to clipboard:', value);
  return { ok: true, fallback: true };
}

async function tryReadClipboardText() {
  // Clipboard read generally requires HTTPS and a user gesture; many mobile browsers
  // still block it. We avoid prompt-based fallbacks because they are commonly blocked
  // once an awaited clipboard call has occurred.
  if (!window.isSecureContext) return { ok: false, error: 'Clipboard read requires HTTPS' };
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    return { ok: false, error: 'Clipboard API unavailable' };
  }

  try {
    const text = await navigator.clipboard.readText();
    return { ok: true, text: String(text || '') };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Clipboard read blocked' };
  }
}

function createPaneRuntime(paneId, terminalId, title) {
  const frame = document.createElement('article');
  frame.className = 'pane';
  frame.dataset.paneId = paneId;

  const head = document.createElement('header');
  head.className = 'pane-head';

  const label = document.createElement('span');
  label.textContent = title;

  const small = document.createElement('span');
  small.textContent = `${terminalId.slice(0, 8)} · connecting`;

  head.appendChild(label);
  head.appendChild(small);

  const termMount = document.createElement('div');
  termMount.className = 'pane-term';

  frame.appendChild(head);
  frame.appendChild(termMount);

  const actions = document.createElement('div');
  actions.className = 'pane-actions';
  const shortcutRow = document.createElement('div');
  shortcutRow.className = 'shortcut-row';
  actions.appendChild(shortcutRow);

  const pasteRow = document.createElement('div');
  pasteRow.className = 'paste-row hidden';

  const pasteTa = document.createElement('textarea');
  pasteTa.setAttribute('rows', '1');
  pasteTa.setAttribute('placeholder', 'Paste text here...');

  const pasteSend = document.createElement('button');
  pasteSend.type = 'button';
  pasteSend.className = 'mini-btn primary';
  pasteSend.textContent = 'Send';

  const pasteCancel = document.createElement('button');
  pasteCancel.type = 'button';
  pasteCancel.className = 'mini-btn';
  pasteCancel.textContent = 'Cancel';

  pasteRow.appendChild(pasteTa);
  pasteRow.appendChild(pasteSend);
  pasteRow.appendChild(pasteCancel);
  actions.appendChild(pasteRow);
  frame.appendChild(actions);

  const term = new window.Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 14,
    theme: {
      background: '#0f111a',
      foreground: '#e6edf3',
      cursor: '#e6edf3',
    },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termMount);
  fit.fit();

  // Mobile: xterm can consume/stop bubbling pointer events, so rely on capture-phase
  // handlers on the mount to reliably activate/focus. Also avoid stealing scroll gestures:
  // focus only on "tap" for touch pointers.
  let touchTap = null;
  termMount.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') {
        touchTap = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
        setActivePane(paneId);
        return;
      }
      setActivePane(paneId);
      term.focus();
    },
    { capture: true },
  );

  termMount.addEventListener(
    'pointermove',
    (e) => {
      if (!touchTap || e.pointerId !== touchTap.id) return;
      const dx = e.clientX - touchTap.x;
      const dy = e.clientY - touchTap.y;
      if (dx * dx + dy * dy > 36) touchTap.moved = true;
    },
    { capture: true },
  );

  function endTouchTap(e) {
    if (!touchTap || e.pointerId !== touchTap.id) return;
    const moved = touchTap.moved;
    touchTap = null;
    if (!moved) term.focus();
  }

  termMount.addEventListener('pointerup', endTouchTap, { capture: true });
  termMount.addEventListener('pointercancel', endTouchTap, { capture: true });

  const runtime = {
    paneId,
    terminalId,
    frame,
    headLabelEl: label,
    headStateEl: small,
    term,
    fit,
    observer: null,
    socket: null,
    shortcutRow,
    pasteRow,
    pasteTa,
    suppressShortcutClickUntil: 0,
  };

  function showPasteRow(prefill = '') {
    pasteTa.value = String(prefill || '');
    runtime.pasteRow.classList.remove('hidden');
    requestAnimationFrame(() => pasteTa.focus());
  }

  function hidePasteRow() {
    runtime.pasteRow.classList.add('hidden');
    pasteTa.value = '';
  }

  pasteCancel.addEventListener('click', (e) => {
    e.preventDefault();
    hidePasteRow();
    runtime.term.focus();
  });

  pasteSend.addEventListener('click', (e) => {
    e.preventDefault();
    const text = String(pasteTa.value || '');
    if (text) sendInput(runtime, text);
    hidePasteRow();
    runtime.term.focus();
  });

  pasteTa.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hidePasteRow();
      runtime.term.focus();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const text = String(pasteTa.value || '');
      if (text) sendInput(runtime, text);
      hidePasteRow();
      runtime.term.focus();
    }
  });

  function rebuildShortcutButtons() {
    const order = loadShortcutOrder();
    runtime.shortcutRow.innerHTML = '';

    for (const key of order) {
      const def = SHORTCUTS_BY_KEY.get(key);
      if (!def) continue;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shortcut-btn';
      btn.textContent = def.label;
      btn.dataset.key = def.key;
      if (def.title) btn.title = def.title;

      btn.addEventListener('click', async (event) => {
        if (Date.now() < runtime.suppressShortcutClickUntil) return;
        event.preventDefault();
        setActivePane(paneId);

        if (def.kind === 'send') {
          sendInput(runtime, def.data);
          runtime.term.focus();
          return;
        }

        if (def.kind === 'copy') {
          const text = typeof runtime.term.getSelection === 'function' ? runtime.term.getSelection() : '';
          const res = await copyText(text);
          if (!res.ok) setStatus(`Copy failed: ${res.error}`);
          else setStatus(res.fallback ? 'Copy: manual prompt used' : 'Copied');
          runtime.term.focus();
          return;
        }

        if (def.kind === 'paste') {
          // Prefer real clipboard when available; otherwise show a paste panel.
          const res = await tryReadClipboardText();
          if (res.ok) {
            if (res.text) sendInput(runtime, res.text);
            runtime.term.focus();
            return;
          }
          showPasteRow('');
          setStatus(`Paste: ${res.error}`);
        }
      });

      runtime.shortcutRow.appendChild(btn);
    }
  }

  function persistOrderFromDom() {
    const keys = [...runtime.shortcutRow.querySelectorAll('button.shortcut-btn')]
      .map((b) => String(b.dataset.key || '').trim())
      .filter((k) => !!k && SHORTCUTS_BY_KEY.has(k));
    saveShortcutOrder(keys);
    for (const rt of state.runtimes.values()) {
      if (rt && typeof rt.rebuildShortcutButtons === 'function') rt.rebuildShortcutButtons();
    }
  }

  function installShortcutReorder() {
    let drag = null;

    function startDrag(button, e) {
      drag = {
        pointerId: e.pointerId,
        button,
        started: true,
      };

      runtime.suppressShortcutClickUntil = Date.now() + 400;
      runtime.shortcutRow.classList.add('dragging');
      button.classList.add('dragging');

      if (typeof button.setPointerCapture === 'function') {
        try {
          button.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    }

    function stopDrag() {
      if (!drag) return;
      const { button, pointerId } = drag;
      drag = null;

      runtime.shortcutRow.classList.remove('dragging');
      if (button) button.classList.remove('dragging');

      if (button && typeof button.releasePointerCapture === 'function') {
        try {
          button.releasePointerCapture(pointerId);
        } catch {
          // ignore
        }
      }

      persistOrderFromDom();
    }

    function onMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.preventDefault();

      const buttons = [...runtime.shortcutRow.querySelectorAll('button.shortcut-btn')].filter((b) => b !== drag.button);
      let before = null;
      for (const b of buttons) {
        const r = b.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (e.clientX < mid) {
          before = b;
          break;
        }
      }

      runtime.shortcutRow.insertBefore(drag.button, before);
    }

    function onUp(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      stopDrag();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }

    runtime.shortcutRow.addEventListener('pointerdown', (e) => {
      const button = e.target && e.target.closest ? e.target.closest('button.shortcut-btn') : null;
      if (!button || !runtime.shortcutRow.contains(button)) return;

      // Touch: long-press to reorder so scrolling the bar still works.
      if (e.pointerType === 'touch') {
        const startX = e.clientX;
        const startY = e.clientY;
        let cancelled = false;
        const t = setTimeout(() => {
          if (cancelled) return;
          startDrag(button, e);
          window.addEventListener('pointermove', onMove, { passive: false });
          window.addEventListener('pointerup', onUp);
          window.addEventListener('pointercancel', onUp);
        }, 240);

        const cancel = () => {
          cancelled = true;
          clearTimeout(t);
          button.removeEventListener('pointermove', moveCheck);
          button.removeEventListener('pointerup', cancel);
          button.removeEventListener('pointercancel', cancel);
        };

        const moveCheck = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (dx * dx + dy * dy > 144) cancel();
        };

        button.addEventListener('pointermove', moveCheck);
        button.addEventListener('pointerup', cancel);
        button.addEventListener('pointercancel', cancel);
        return;
      }

      // Mouse/stylus: start immediately.
      if (e.button != null && e.button !== 0) return;
      startDrag(button, e);
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  runtime.rebuildShortcutButtons = rebuildShortcutButtons;
  rebuildShortcutButtons();
  installShortcutReorder();

  runtime.observer = new ResizeObserver(() => {
    runtime.fit.fit();
  });
  runtime.observer.observe(termMount);

  frame.addEventListener('pointerdown', () => {
    setActivePane(paneId);
  });

  term.onData((data) => {
    sendInput(runtime, data);
  });

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if (handleFocusShortcut(event)) return false;
    return true;
  });

  connectPaneRuntime(runtime);
  return runtime;
}

function isValidPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function normalizeWebSpec(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  if (/^\d{1,5}$/.test(value)) {
    const port = Number(value);
    if (!isValidPort(port)) return null;
    return { port, path: '/' };
  }

  try {
    const url = new URL(value.startsWith('http://') || value.startsWith('https://') ? value : `http://${value}`);
    const host = url.hostname;
    if (!(host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1')) return null;
    const port = Number(url.port || '80');
    if (!isValidPort(port)) return null;
    const path = `${url.pathname || '/'}${url.search || ''}${url.hash || ''}`;
    return { port, path: path.startsWith('/') ? path : `/${path}` };
  } catch {
    return null;
  }
}

function webProxyUrl(spec) {
  const port = Number(spec && spec.port);
  if (!isValidPort(port)) return '/';
  const path = String(spec && spec.path ? spec.path : '/');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `/proxy/http/${port}${normalizedPath}`;
}

function createWebPaneRuntime(paneId, web, title) {
  const frame = document.createElement('article');
  frame.className = 'pane';
  frame.dataset.paneId = paneId;

  const head = document.createElement('header');
  head.className = 'pane-head';

  const label = document.createElement('span');
  label.textContent = title;

  const small = document.createElement('span');
  small.textContent = `web · ${String(web && web.port ? web.port : '')}`;

  head.appendChild(label);
  head.appendChild(small);

  const webMount = document.createElement('div');
  webMount.className = 'pane-web';

  const iframe = document.createElement('iframe');
  // Keep this sandboxed: proxied pages should not get a same-origin script context
  // with the terminal UI.
  iframe.setAttribute('sandbox', 'allow-forms allow-scripts allow-popups allow-modals allow-downloads');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.src = webProxyUrl(web);
  webMount.appendChild(iframe);

  frame.appendChild(head);
  frame.appendChild(webMount);

  const actions = document.createElement('div');
  actions.className = 'pane-actions';
  const row = document.createElement('div');
  row.className = 'shortcut-row';
  actions.appendChild(row);
  frame.appendChild(actions);

  const addr = document.createElement('input');
  addr.className = 'addr';
  addr.type = 'text';
  addr.autocomplete = 'off';
  addr.autocapitalize = 'off';
  addr.spellcheck = false;
  addr.value = `http://127.0.0.1:${web && web.port ? web.port : ''}${web && web.path ? web.path : '/'}`;

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'mini-btn primary';
  go.textContent = 'Go';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'mini-btn';
  reload.textContent = 'Reload';

  row.appendChild(addr);
  row.appendChild(go);
  row.appendChild(reload);

  function navigateFromAddr() {
    const spec = normalizeWebSpec(addr.value);
    if (!spec) {
      setStatus('Web pane: enter a localhost URL (e.g. 3000 or http://127.0.0.1:3000/)');
      return;
    }
    // Persist into pane model for workspace save.
    const pane = state.panes.get(paneId);
    if (pane && pane.type === 'web') {
      pane.web = { port: spec.port, path: spec.path };
      pane.title = `Web ${spec.port}`;
    }
    label.textContent = `Web ${spec.port}`;
    small.textContent = `web · ${spec.port}`;
    iframe.src = webProxyUrl(spec);
    saveWorkspaceSoon();
  }

  go.addEventListener('click', (e) => {
    e.preventDefault();
    setActivePane(paneId);
    navigateFromAddr();
  });

  reload.addEventListener('click', (e) => {
    e.preventDefault();
    setActivePane(paneId);
    iframe.src = iframe.src;
  });

  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setActivePane(paneId);
      navigateFromAddr();
    }
  });

  frame.addEventListener('pointerdown', () => {
    setActivePane(paneId);
  });

  return {
    paneId,
    frame,
    headLabelEl: label,
    headStateEl: small,
    iframe,
  };
}

function disconnectPaneRuntime(runtime) {
  if (!runtime) return;
  if (runtime.socket) {
    runtime.socket.onclose = null;
    runtime.socket.onerror = null;
    runtime.socket.onmessage = null;
    runtime.socket.close();
    runtime.socket = null;
  }
}

function disposePaneRuntime(paneId) {
  const runtime = state.runtimes.get(paneId);
  if (!runtime) return;
  disconnectPaneRuntime(runtime);
  if (runtime.observer) runtime.observer.disconnect();
  if (runtime.resizeObs) runtime.resizeObs.disconnect();
  if (runtime.term) runtime.term.dispose();
  runtime.frame.remove();
  state.runtimes.delete(paneId);
  state.panes.delete(paneId);
}

function connectPaneRuntime(runtime) {
  disconnectPaneRuntime(runtime);

  const ws = new WebSocket(socketUrl(`${state.wsPath}?terminalId=${encodeURIComponent(runtime.terminalId)}`));
  runtime.socket = ws;

  ws.onopen = () => {
    runtime.fit.fit();
    runtime.term.focus();
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'ready') {
      runtime.headStateEl.textContent = `${runtime.terminalId.slice(0, 8)} · ${msg.status}`;
      return;
    }

    if (msg.type === 'output' && typeof msg.data === 'string') {
      runtime.term.write(msg.data);
      return;
    }

    if (msg.type === 'exit') {
      runtime.headStateEl.textContent = `${runtime.terminalId.slice(0, 8)} · exited`;
      runtime.term.write(`\r\n\r\n[terminal exited code=${msg.code ?? 'null'} signal=${msg.signal ?? 'null'}]\r\n`);
      return;
    }

    if (msg.type === 'error' && msg.error) {
      runtime.headStateEl.textContent = `${runtime.terminalId.slice(0, 8)} · error`;
      runtime.term.write(`\r\n[error] ${msg.error}\r\n`);
    }
  };

  ws.onclose = () => {
    if (runtime.socket === ws) runtime.socket = null;
    if (state.authenticated) {
      runtime.headStateEl.textContent = `${runtime.terminalId.slice(0, 8)} · disconnected`;
    }
  };

  ws.onerror = () => {
    runtime.headStateEl.textContent = `${runtime.terminalId.slice(0, 8)} · connection error`;
  };
}

function createPane(terminalSummary) {
  const paneId = uid('pane');
  const pane = {
    id: paneId,
    type: 'terminal',
    terminalId: terminalSummary.id,
    title: terminalSummary.title || `terminal-${terminalSummary.id.slice(0, 8)}`,
  };

  state.panes.set(paneId, pane);
  const runtime = createPaneRuntime(paneId, pane.terminalId, pane.title);
  state.runtimes.set(paneId, runtime);

  return pane;
}

function createWebPane(web) {
  const paneId = uid('pane');
  const port = Number(web && web.port);
  const path = String(web && web.path ? web.path : '/');
  const pane = {
    id: paneId,
    type: 'web',
    web: { port: isValidPort(port) ? port : 80, path: path.startsWith('/') ? path : `/${path}` },
    title: `Web ${isValidPort(port) ? port : 80}`,
  };

  state.panes.set(paneId, pane);
  const runtime = createWebPaneRuntime(paneId, pane.web, pane.title);
  state.runtimes.set(paneId, runtime);
  return pane;
}

async function createBrowserSessionOnServer(url, width, height) {
  const data = await postJson('/api/web/sessions', { url, width, height });
  return data.session;
}

function normalizeAnyUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    // Support entering "google.com" or "localhost:3000"
    const u = new URL(value.includes('://') ? value : `https://${value}`);
    // Disallow file:// etc.
    if (!(u.protocol === 'http:' || u.protocol === 'https:')) return null;
    return u.toString();
  } catch {
    // If https default failed, try http.
    try {
      const u = new URL(value.includes('://') ? value : `http://${value}`);
      if (!(u.protocol === 'http:' || u.protocol === 'https:')) return null;
      return u.toString();
    } catch {
      return null;
    }
  }
}

function createBrowserPaneRuntime(paneId, session, title) {
  const frame = document.createElement('article');
  frame.className = 'pane';
  frame.dataset.paneId = paneId;

  const head = document.createElement('header');
  head.className = 'pane-head';

  const label = document.createElement('span');
  label.textContent = title;

  const small = document.createElement('span');
  small.textContent = `browser · connecting`;

  head.appendChild(label);
  head.appendChild(small);

  const mount = document.createElement('div');
  mount.className = 'pane-web';

  const img = document.createElement('img');
  img.alt = 'Browser stream';
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'contain';
  img.style.background = '#0f111a';
  mount.appendChild(img);

  // Keyboard capture for mobile: focus this to bring up the virtual keyboard and
  // forward typed text to the host browser session.
  const kbd = document.createElement('textarea');
  kbd.className = 'kbd-capture';
  kbd.setAttribute('aria-hidden', 'true');
  kbd.setAttribute('tabindex', '-1');
  frame.appendChild(kbd);

  frame.appendChild(head);
  frame.appendChild(mount);

  const actions = document.createElement('div');
  actions.className = 'pane-actions';
  const row = document.createElement('div');
  row.className = 'shortcut-row';
  actions.appendChild(row);
  frame.appendChild(actions);

  const addr = document.createElement('input');
  addr.className = 'addr';
  addr.type = 'text';
  addr.autocomplete = 'off';
  addr.autocapitalize = 'off';
  addr.spellcheck = false;
  addr.value = session && session.url ? session.url : 'https://google.com/';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'mini-btn primary';
  go.textContent = 'Go';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'mini-btn';
  reload.textContent = 'Reload';

  row.appendChild(addr);
  row.appendChild(go);
  row.appendChild(reload);

  const runtime = {
    paneId,
    frame,
    headLabelEl: label,
    headStateEl: small,
    img,
    mount,
    addr,
    go,
    reload,
    ws: null,
    sessionId: session && session.id ? session.id : '',
    url: session && session.url ? session.url : '',
    width: session && session.width ? session.width : 900,
    height: session && session.height ? session.height : 600,
    frameW: session && session.width ? session.width : 900,
    frameH: session && session.height ? session.height : 600,
    resizeObs: null,
    kbd,
  };

  function send(msg) {
    if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) return;
    runtime.ws.send(JSON.stringify(msg));
  }

  function connect() {
    const ws = new WebSocket(socketUrl(`${state.webWsPath}?sessionId=${encodeURIComponent(runtime.sessionId)}`));
    runtime.ws = ws;

    ws.onopen = () => {
      runtime.headStateEl.textContent = `browser · connected`;
      // Trigger an initial resize frame.
      send({ type: 'resize', width: runtime.width, height: runtime.height });
      if (runtime.url) send({ type: 'nav', url: runtime.url });
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'ready') {
        runtime.headStateEl.textContent = `browser · ready`;
        return;
      }
      if (msg.type === 'frame' && msg.data) {
        if (Number.isFinite(Number(msg.width))) runtime.frameW = Number(msg.width);
        if (Number.isFinite(Number(msg.height))) runtime.frameH = Number(msg.height);
        runtime.img.src = `data:image/${msg.format || 'jpeg'};base64,${msg.data}`;
        return;
      }
      if (msg.type === 'error' && msg.error) {
        runtime.headStateEl.textContent = `browser · error`;
        setStatus(`Browser: ${msg.error}`);
      }
    };

    ws.onclose = () => {
      if (runtime.ws === ws) runtime.ws = null;
      runtime.headStateEl.textContent = `browser · disconnected`;
    };

    ws.onerror = () => {
      runtime.headStateEl.textContent = `browser · ws error`;
    };
  }

  function updateSize() {
    const rect = runtime.mount.getBoundingClientRect();
    const w = Math.max(240, Math.min(1920, Math.trunc(rect.width || runtime.width)));
    const h = Math.max(180, Math.min(1200, Math.trunc(rect.height || runtime.height)));
    runtime.width = w;
    runtime.height = h;
    send({ type: 'resize', width: w, height: h });
  }

  runtime.resizeObs = new ResizeObserver(() => updateSize());
  runtime.resizeObs.observe(runtime.mount);

  function focusBrowserKeyboard() {
    // For mobile browsers: focusing an offscreen textarea is enough to show keyboard.
    // Don't steal focus if the address bar is focused.
    if (document.activeElement === addr) return;
    try {
      runtime.kbd.focus({ preventScroll: true });
    } catch {
      runtime.kbd.focus();
    }
  }

  function mapClientToViewport(clientX, clientY) {
    const rect = runtime.mount.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    const fw = Number(runtime.frameW || runtime.width || 900);
    const fh = Number(runtime.frameH || runtime.height || 600);
    const mw = Math.max(1, rect.width);
    const mh = Math.max(1, rect.height);

    // object-fit: contain mapping (account for letterboxing).
    const scale = Math.min(mw / fw, mh / fh);
    const dispW = fw * scale;
    const dispH = fh * scale;
    const offX = (mw - dispW) / 2;
    const offY = (mh - dispH) / 2;

    let x = (mx - offX) / scale;
    let y = (my - offY) / scale;
    x = Math.max(0, Math.min(fw - 1, x));
    y = Math.max(0, Math.min(fh - 1, y));
    return { x, y };
  }

  function navFromAddr() {
    const url = normalizeAnyUrl(runtime.addr.value);
    if (!url) {
      setStatus('Browser pane: enter a valid http(s) URL');
      return;
    }
    runtime.url = url;
    const pane = state.panes.get(paneId);
    if (pane && pane.type === 'browser') {
      pane.url = url;
      pane.title = `Browser`;
    }
    send({ type: 'nav', url });
    saveWorkspaceSoon();
  }

  go.addEventListener('click', (e) => {
    e.preventDefault();
    setActivePane(paneId);
    navFromAddr();
  });

  reload.addEventListener('click', (e) => {
    e.preventDefault();
    setActivePane(paneId);
    send({ type: 'nav', url: runtime.url || normalizeAnyUrl(runtime.addr.value) || 'about:blank' });
  });

  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setActivePane(paneId);
      navFromAddr();
    }
  });

  frame.addEventListener('pointerdown', () => setActivePane(paneId));

  // Touch + mouse input forwarding.
  let touch = null;
  let mouseDown = false;

  mount.addEventListener(
    'pointerdown',
    (e) => {
      setActivePane(paneId);
      focusBrowserKeyboard();

      if (e.pointerType === 'touch') {
        touch = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
        };
        if (typeof mount.setPointerCapture === 'function') {
          try {
            mount.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }
        e.preventDefault();
        return;
      }

      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        const { x, y } = mapClientToViewport(e.clientX, e.clientY);
        mouseDown = true;
        send({ type: 'input', event: { kind: 'mousedown', x, y, button: e.button } });
        if (typeof mount.setPointerCapture === 'function') {
          try {
            mount.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }
        e.preventDefault();
      }
    },
    { passive: false },
  );

  mount.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') {
        if (!touch || e.pointerId !== touch.id) return;
        const dx = e.clientX - touch.lastX;
        const dy = e.clientY - touch.lastY;
        touch.lastX = e.clientX;
        touch.lastY = e.clientY;

        const movedDx = e.clientX - touch.startX;
        const movedDy = e.clientY - touch.startY;
        if (!touch.moved && movedDx * movedDx + movedDy * movedDy > 64) touch.moved = true;

        // Treat drags as scroll (wheel) in the host browser.
        if (touch.moved) {
          send({ type: 'input', event: { kind: 'wheel', dx: -dx, dy: -dy } });
        }
        e.preventDefault();
        return;
      }

      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        const { x, y } = mapClientToViewport(e.clientX, e.clientY);
        send({ type: 'input', event: { kind: 'mousemove', x, y } });
        e.preventDefault();
      }
    },
    { passive: false },
  );

  mount.addEventListener(
    'pointerup',
    (e) => {
      if (e.pointerType === 'touch') {
        if (!touch || e.pointerId !== touch.id) return;
        const { x, y } = mapClientToViewport(e.clientX, e.clientY);
        const wasTap = !touch.moved;
        touch = null;
        if (typeof mount.releasePointerCapture === 'function') {
          try {
            mount.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }
        if (wasTap) {
          // Tap = click.
          send({ type: 'input', event: { kind: 'mousedown', x, y, button: 0 } });
          send({ type: 'input', event: { kind: 'mouseup', x, y, button: 0 } });
        }
        e.preventDefault();
        return;
      }

      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        if (!mouseDown) return;
        const { x, y } = mapClientToViewport(e.clientX, e.clientY);
        mouseDown = false;
        send({ type: 'input', event: { kind: 'mouseup', x, y, button: e.button } });
        if (typeof mount.releasePointerCapture === 'function') {
          try {
            mount.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }
        e.preventDefault();
      }
    },
    { passive: false },
  );

  mount.addEventListener(
    'pointercancel',
    (e) => {
      if (e.pointerType === 'touch' && touch && e.pointerId === touch.id) {
        touch = null;
      }
      if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && mouseDown) {
        mouseDown = false;
      }
      try {
        if (typeof mount.releasePointerCapture === 'function') mount.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    { passive: false },
  );

  mount.addEventListener(
    'wheel',
    (e) => {
      const { x, y } = mapClientToViewport(e.clientX, e.clientY);
      // Ensure we have a recent mouse position.
      send({ type: 'input', event: { kind: 'mousemove', x, y } });
      send({ type: 'input', event: { kind: 'wheel', dx: e.deltaX, dy: e.deltaY } });
      e.preventDefault();
    },
    { passive: false },
  );

  // Text input handling (mobile + desktop).
  runtime.kbd.addEventListener('input', () => {
    if (state.activePaneId !== paneId) return;
    const text = String(runtime.kbd.value || '');
    if (!text) return;
    runtime.kbd.value = '';
    send({ type: 'input', event: { kind: 'text', text } });
  });

  runtime.kbd.addEventListener('compositionend', () => {
    // IME: flush composed text.
    if (state.activePaneId !== paneId) return;
    const text = String(runtime.kbd.value || '');
    if (!text) return;
    runtime.kbd.value = '';
    send({ type: 'input', event: { kind: 'text', text } });
  });

  runtime.kbd.addEventListener('keydown', (e) => {
    if (state.activePaneId !== paneId) return;
    if (e.ctrlKey && e.altKey) return; // reserved for workspace shortcuts
    if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab' || e.key === 'Escape') {
      send({ type: 'input', event: { kind: 'key', action: 'press', key: e.key } });
      e.preventDefault();
      return;
    }
    if (e.key && e.key.startsWith('Arrow')) {
      send({ type: 'input', event: { kind: 'key', action: 'press', key: e.key } });
      e.preventDefault();
    }
  });

  connect();
  updateSize();
  return runtime;
}

function createBrowserPane(session) {
  const paneId = uid('pane');
  const pane = {
    id: paneId,
    type: 'browser',
    sessionId: String(session && session.id ? session.id : ''),
    url: String(session && session.url ? session.url : ''),
    title: 'Browser',
  };
  state.panes.set(paneId, pane);
  const runtime = createBrowserPaneRuntime(paneId, session, pane.title);
  state.runtimes.set(paneId, runtime);
  return pane;
}

function createLeafNode(paneId) {
  return { kind: 'leaf', paneId };
}

function createTabFromTerminal(terminalSummary) {
  const pane = createPane(terminalSummary);
  const tab = {
    id: uid('tab'),
    title: terminalSummary.title || `Terminal ${terminalSummary.id.slice(0, 8)}`,
    root: createLeafNode(pane.id),
  };
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  state.activePaneId = pane.id;
  renderAll();
  saveWorkspaceSoon();
}

function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

function setActivePane(paneId) {
  if (!state.panes.has(paneId)) return;
  state.activePaneId = paneId;

  const tab = state.tabs.find((t) => containsPane(t.root, paneId));
  if (tab) state.activeTabId = tab.id;

  renderTabs();
  refreshPaneActiveStyles();
  const runtime = state.runtimes.get(paneId);
  if (runtime && runtime.term) runtime.term.focus();
  if (runtime && runtime.kbd) {
    try {
      runtime.kbd.focus({ preventScroll: true });
    } catch {
      runtime.kbd.focus();
    }
  }
  saveWorkspaceSoon();
}

function containsPane(node, paneId) {
  if (!node) return false;
  if (node.kind === 'leaf') return node.paneId === paneId;
  return containsPane(node.a, paneId) || containsPane(node.b, paneId);
}

function splitNodeByPane(node, paneId, newPaneId, direction) {
  if (!node) return node;
  if (node.kind === 'leaf' && node.paneId === paneId) {
    return {
      kind: 'split',
      direction,
      ratio: 0.5,
      a: { kind: 'leaf', paneId },
      b: { kind: 'leaf', paneId: newPaneId },
    };
  }

  if (node.kind === 'split') {
    node.a = splitNodeByPane(node.a, paneId, newPaneId, direction);
    node.b = splitNodeByPane(node.b, paneId, newPaneId, direction);
  }

  return node;
}

function removePaneFromNode(node, paneId) {
  if (!node) return null;
  if (node.kind === 'leaf') return node.paneId === paneId ? null : node;

  const left = removePaneFromNode(node.a, paneId);
  const right = removePaneFromNode(node.b, paneId);

  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;

  node.a = left;
  node.b = right;
  return node;
}

function firstPaneId(node) {
  if (!node) return '';
  if (node.kind === 'leaf') return node.paneId;
  return firstPaneId(node.a) || firstPaneId(node.b);
}

function serializeNode(node) {
  if (!node) return null;

  if (node.kind === 'leaf') {
    const pane = state.panes.get(node.paneId);
    if (!pane) return null;
    if (pane.type === 'web') {
      return {
        kind: 'leaf',
        type: 'web',
        web: {
          port: Number(pane.web && pane.web.port),
          path: String(pane.web && pane.web.path ? pane.web.path : '/'),
        },
        title: String(pane.title || ''),
      };
    }
    if (pane.type === 'browser') {
      return {
        kind: 'leaf',
        type: 'browser',
        url: String(pane.url || ''),
        title: String(pane.title || ''),
      };
    }
    return { kind: 'leaf', type: 'terminal', terminalId: pane.terminalId, title: String(pane.title || '') };
  }

  const a = serializeNode(node.a);
  const b = serializeNode(node.b);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return {
    kind: 'split',
    direction: node.direction === 'column' ? 'column' : 'row',
    ratio: typeof node.ratio === 'number' ? node.ratio : 0.5,
    a,
    b,
  };
}

function serializeActiveLeaf() {
  const pane = state.panes.get(state.activePaneId);
  if (!pane) return null;
  if (pane.type === 'web') {
    return {
      type: 'web',
      web: {
        port: Number(pane.web && pane.web.port),
        path: String(pane.web && pane.web.path ? pane.web.path : '/'),
      },
    };
  }
  if (pane.type === 'browser') {
    return { type: 'browser', url: String(pane.url || '') };
  }
  return { type: 'terminal', terminalId: String(pane.terminalId || '') };
}

function saveWorkspaceSoon(delayMs = 250) {
  if (!state.authenticated) return;
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    state.saveTimer = null;
    try {
      const tabs = state.tabs
        .map((tab) => ({
          id: tab.id,
          title: tab.title,
          root: serializeNode(tab.root),
        }))
        .filter((tab) => !!tab.root);

      const activePane = state.panes.get(state.activePaneId);
      await putJson('/api/workspace', {
        workspace: {
          tabs,
          activeTabId: state.activeTabId || '',
          activeTerminalId: activePane ? activePane.terminalId : '',
          activeLeaf: serializeActiveLeaf(),
        },
      });
    } catch {
      // best-effort persistence
    }
  }, delayMs);
}

function startSplitDrag(splitNode, splitWrap, firstEl, secondEl, captureEl, pointerId) {
  const isRow = splitNode.direction === 'row';

  function applyRatio() {
    firstEl.style.flex = `${splitNode.ratio} 1 0`;
    secondEl.style.flex = `${1 - splitNode.ratio} 1 0`;
  }

  applyRatio();

  function onMove(event) {
    // Prevent the browser from interpreting this drag as scroll/zoom on touch devices.
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const rect = splitWrap.getBoundingClientRect();
    if (isRow) {
      const ratio = (event.clientX - rect.left) / rect.width;
      splitNode.ratio = Math.min(0.9, Math.max(0.1, ratio));
    } else {
      const ratio = (event.clientY - rect.top) / rect.height;
      splitNode.ratio = Math.min(0.9, Math.max(0.1, ratio));
    }
    applyRatio();
    requestAnimationFrame(() => {
      for (const runtime of state.runtimes.values()) runtime.fit.fit();
    });
  }

  function cleanup() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('dragging-split');

    if (captureEl && typeof captureEl.releasePointerCapture === 'function' && Number.isFinite(pointerId)) {
      try {
        captureEl.releasePointerCapture(pointerId);
      } catch {
        // best-effort; some browsers throw if capture was lost
      }
    }
  }

  function onUp() {
    cleanup();
    saveWorkspaceSoon();
  }

  document.body.classList.add('dragging-split');
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function renderNode(node, parent) {
  if (!node) return;

  if (node.kind === 'leaf') {
    const runtime = state.runtimes.get(node.paneId);
    if (runtime) parent.appendChild(runtime.frame);
    return;
  }

  const splitWrap = document.createElement('section');
  splitWrap.className = `split ${node.direction}`;

  const first = document.createElement('div');
  first.className = 'split-child';
  first.style.flex = `${node.ratio} 1 0`;

  const splitter = document.createElement('div');
  splitter.className = `splitter ${node.direction}`;
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (typeof splitter.setPointerCapture === 'function') {
      try {
        splitter.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers may not support capture for all pointer types.
      }
    }
    startSplitDrag(node, splitWrap, first, second, splitter, e.pointerId);
  });

  const second = document.createElement('div');
  second.className = 'split-child';
  second.style.flex = `${1 - node.ratio} 1 0`;

  renderNode(node.a, first);
  renderNode(node.b, second);

  splitWrap.appendChild(first);
  splitWrap.appendChild(splitter);
  splitWrap.appendChild(second);
  parent.appendChild(splitWrap);
}

function refreshPaneActiveStyles() {
  for (const runtime of state.runtimes.values()) {
    runtime.frame.classList.toggle('active', runtime.paneId === state.activePaneId);
  }
}

function renderTabs() {
  tabbarEl.innerHTML = '';

  for (const tab of state.tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tab-btn${tab.id === state.activeTabId ? ' active' : ''}`;
    btn.textContent = tab.title;
    btn.addEventListener('click', () => {
      state.activeTabId = tab.id;
      const paneId = firstPaneId(tab.root);
      if (paneId) state.activePaneId = paneId;
      renderAll();
      saveWorkspaceSoon();
    });
    tabbarEl.appendChild(btn);
  }
}

function renderWorkspace() {
  workspaceEl.innerHTML = '';
  const tab = getActiveTab();
  if (!tab || !tab.root) return;

  renderNode(tab.root, workspaceEl);
  refreshPaneActiveStyles();

  requestAnimationFrame(() => {
    for (const runtime of state.runtimes.values()) runtime.fit.fit();
    const active = state.runtimes.get(state.activePaneId);
    if (active) active.term.focus();
  });
}

function renderAll() {
  renderTabs();
  renderWorkspace();
}

function switchToTabByNumber(n) {
  const idx = n - 1;
  if (idx < 0 || idx >= state.tabs.length) return;
  const tab = state.tabs[idx];
  if (!tab) return;
  state.activeTabId = tab.id;
  const paneId = firstPaneId(tab.root);
  if (paneId) state.activePaneId = paneId;
  renderAll();
  saveWorkspaceSoon();
}

function focusPaneByDirection(direction) {
  const active = state.runtimes.get(state.activePaneId);
  if (!active) return;

  const sourceRect = active.frame.getBoundingClientRect();
  const sx = sourceRect.left + sourceRect.width / 2;
  const sy = sourceRect.top + sourceRect.height / 2;
  const candidates = [];

  for (const runtime of state.runtimes.values()) {
    if (runtime.paneId === state.activePaneId) continue;
    if (!runtime.frame.isConnected) continue;

    const r = runtime.frame.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - sx;
    const dy = cy - sy;

    let primary;
    let secondary;

    if (direction === 'left' && dx < -4) {
      primary = -dx;
      secondary = Math.abs(dy);
    } else if (direction === 'right' && dx > 4) {
      primary = dx;
      secondary = Math.abs(dy);
    } else if (direction === 'up' && dy < -4) {
      primary = -dy;
      secondary = Math.abs(dx);
    } else if (direction === 'down' && dy > 4) {
      primary = dy;
      secondary = Math.abs(dx);
    } else {
      continue;
    }

    candidates.push({ paneId: runtime.paneId, score: primary * 10 + secondary });
  }

  candidates.sort((a, b) => a.score - b.score);
  if (candidates[0]) {
    setActivePane(candidates[0].paneId);
  }
}

function handleFocusShortcut(event) {
  if (!state.authenticated) return false;
  // All workspace shortcuts require Ctrl+Alt to avoid collisions with common browser/system bindings.
  if (!event.ctrlKey || !event.altKey || event.metaKey) return false;

  const consume = () => {
    event.preventDefault();
    // Avoid double-triggering via xterm's custom key handler and the window keydown listener.
    // stopImmediatePropagation may not exist in some environments; stopPropagation is enough for bubbling.
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  };

  const isArrow = event.key && event.key.startsWith('Arrow');
  const isPaneHotkey = isArrow && !event.shiftKey;
  if (isPaneHotkey) {
    consume();
    if (event.key === 'ArrowLeft') focusPaneByDirection('left');
    if (event.key === 'ArrowRight') focusPaneByDirection('right');
    if (event.key === 'ArrowUp') focusPaneByDirection('up');
    if (event.key === 'ArrowDown') focusPaneByDirection('down');
    return true;
  }

  if (event.shiftKey) return false;

  const k = String(event.key || '').toLowerCase();
  if (k === 'v') {
    consume();
    splitActivePane('row').catch(() => {});
    return true;
  }
  if (k === 'h') {
    consume();
    splitActivePane('column').catch(() => {});
    return true;
  }
  if (k === 'x') {
    consume();
    exitActiveTerminal().catch(() => {});
    return true;
  }

  if (/^[1-9]$/.test(event.key)) {
    consume();
    switchToTabByNumber(Number(event.key));
    return true;
  }

  return false;
}

function clearWorkspaceState() {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  for (const paneId of [...state.runtimes.keys()]) {
    disposePaneRuntime(paneId);
  }
  state.tabs = [];
  state.activeTabId = '';
  state.activePaneId = '';
  state.panes.clear();
  state.runtimes.clear();
  tabbarEl.innerHTML = '';
  workspaceEl.innerHTML = '';
}

async function createTerminalOnServer() {
  const data = await postJson('/api/terminals', {});
  return data.terminal;
}

async function loadServerConfig() {
  const cfg = await getJson('/api/terminal/config');
  state.shell = cfg.shell || '';
  state.wsPath = cfg.wsPath || '/ws/terminal';
  state.webWsPath = cfg.webWsPath || '/ws/web';
  setMeta(state.shell ? `Shell: ${state.shell}` : 'Shell connected');
}

async function restoreNodeFromWorkspace(node, runningById) {
  if (!node || typeof node !== 'object') return null;

  if (node.kind === 'leaf') {
    const type = String(node.type || '').trim();

    if (!type || type === 'terminal') {
      const terminalId = String(node.terminalId || '').trim();
      const term = runningById.get(terminalId);
      if (!term) return null;
      const pane = createPane(term);
      if (node.title) pane.title = String(node.title);
      return createLeafNode(pane.id);
    }

    if (type === 'web') {
      const web = node.web && typeof node.web === 'object' ? node.web : {};
      const port = Number(web.port);
      const path = String(web.path || '/');
      const pane = createWebPane({ port, path });
      if (node.title) pane.title = String(node.title);
      return createLeafNode(pane.id);
    }

    if (type === 'browser') {
      const url = String(node.url || '').slice(0, 2048);
      if (!url) return null;
      const session = await createBrowserSessionOnServer(url, 900, 600);
      const pane = createBrowserPane(session);
      if (node.title) pane.title = String(node.title);
      return createLeafNode(pane.id);
    }

    return null;
  }

  if (node.kind === 'split') {
    const a = await restoreNodeFromWorkspace(node.a, runningById);
    const b = await restoreNodeFromWorkspace(node.b, runningById);
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    return {
      kind: 'split',
      direction: node.direction === 'column' ? 'column' : 'row',
      ratio: typeof node.ratio === 'number' ? Math.min(0.9, Math.max(0.1, node.ratio)) : 0.5,
      a,
      b,
    };
  }

  return null;
}

async function bootstrapTabsFromServer() {
  clearWorkspaceState();

  const [list, workspaceData] = await Promise.all([
    getJson('/api/terminals'),
    getJson('/api/workspace'),
  ]);
  const running = (list.terminals || []).filter((t) => t.status === 'running');
  const runningById = new Map(running.map((t) => [t.id, t]));
  const workspace = workspaceData.workspace || {};
  const attachedTerminalIds = new Set();

  if (Array.isArray(workspace.tabs)) {
    for (const savedTab of workspace.tabs) {
      let root = null;
      try {
        root = await restoreNodeFromWorkspace(savedTab.root, runningById);
      } catch {
        root = null;
      }
      if (!root) continue;
      const tab = {
        id: String(savedTab.id || uid('tab')),
        title: String(savedTab.title || `Tab ${state.tabs.length + 1}`),
        root,
      };
      state.tabs.push(tab);
    }
  }

  for (const pane of state.panes.values()) {
    if (pane.type === 'terminal' && pane.terminalId) attachedTerminalIds.add(pane.terminalId);
  }

  for (const term of running) {
    if (!attachedTerminalIds.has(term.id)) {
      createTabFromTerminal(term);
    }
  }

  if (state.tabs.length === 0) {
    const term = await createTerminalOnServer();
    createTabFromTerminal(term);
  }

  const preferredTabId = String(workspace.activeTabId || '');
  state.activeTabId = state.tabs.some((t) => t.id === preferredTabId) ? preferredTabId : state.tabs[0].id;

  const preferredTerminalId = String(workspace.activeTerminalId || '');
  const preferredLeaf = workspace.activeLeaf && typeof workspace.activeLeaf === 'object' ? workspace.activeLeaf : null;
  const activeTab = getActiveTab();
  let preferredPaneId = '';
  if (activeTab && preferredLeaf && preferredLeaf.type === 'web') {
    const web = preferredLeaf.web && typeof preferredLeaf.web === 'object' ? preferredLeaf.web : {};
    const port = Number(web.port);
    const path = String(web.path || '/');
    for (const [paneId, pane] of state.panes.entries()) {
      if (pane.type !== 'web') continue;
      if (!pane.web) continue;
      if (Number(pane.web.port) !== port) continue;
      if (String(pane.web.path || '/') !== path) continue;
      if (containsPane(activeTab.root, paneId)) {
        preferredPaneId = paneId;
        break;
      }
    }
  } else if (activeTab && preferredLeaf && preferredLeaf.type === 'terminal') {
    const terminalId = String(preferredLeaf.terminalId || '');
    if (terminalId) {
      for (const [paneId, pane] of state.panes.entries()) {
        if (pane.type !== 'terminal') continue;
        if (pane.terminalId === terminalId && containsPane(activeTab.root, paneId)) {
          preferredPaneId = paneId;
          break;
        }
      }
    }
  } else if (activeTab && preferredTerminalId) {
    for (const [paneId, pane] of state.panes.entries()) {
      if (pane.type !== 'terminal') continue;
      if (pane.terminalId === preferredTerminalId && containsPane(activeTab.root, paneId)) {
        preferredPaneId = paneId;
        break;
      }
    }
  }
  state.activePaneId = preferredPaneId || firstPaneId(getActiveTab() && getActiveTab().root);

  if (state.tabs[0]) {
    renderAll();
    saveWorkspaceSoon();
  }
}

async function addNewTab() {
  const term = await createTerminalOnServer();
  createTabFromTerminal(term);
  setStatus('New terminal tab created');
  saveWorkspaceSoon();
}

async function addNewWebTab(urlRaw) {
  const url = normalizeAnyUrl(urlRaw);
  if (!url) {
    throw new Error('Invalid URL. Use http(s)://');
    return;
  }

  const rect = workspaceEl.getBoundingClientRect();
  const width = Math.trunc(Math.max(360, Math.min(1280, rect.width || 900)));
  const height = Math.trunc(Math.max(240, Math.min(900, rect.height || 600)));
  const session = await createBrowserSessionOnServer(url, width, height);
  const pane = createBrowserPane(session);
  const tab = {
    id: uid('tab'),
    title: `Web`,
    root: createLeafNode(pane.id),
  };

  state.tabs.push(tab);
  state.activeTabId = tab.id;
  state.activePaneId = pane.id;
  renderAll();
  setStatus(`Web tab created`);
  saveWorkspaceSoon();
}

async function splitActivePane(direction) {
  const tab = getActiveTab();
  if (!tab || !state.activePaneId) return;

  const term = await createTerminalOnServer();
  const newPane = createPane(term);

  tab.root = splitNodeByPane(tab.root, state.activePaneId, newPane.id, direction);
  state.activePaneId = newPane.id;
  renderAll();
  setStatus(direction === 'row' ? 'Vertical split created' : 'Horizontal split created');
  saveWorkspaceSoon();
}

async function exitActiveTerminal() {
  const pane = state.panes.get(state.activePaneId);
  const tab = getActiveTab();
  if (!pane || !tab) return;

  await postJson(`/api/terminals/${encodeURIComponent(pane.terminalId)}/exit`, {});

  const paneId = pane.id;
  tab.root = removePaneFromNode(tab.root, paneId);
  disposePaneRuntime(paneId);

  if (!tab.root) {
    state.tabs = state.tabs.filter((t) => t.id !== tab.id);
    if (state.tabs.length > 0) {
      state.activeTabId = state.tabs[0].id;
      state.activePaneId = firstPaneId(state.tabs[0].root);
    } else {
      state.activeTabId = '';
      state.activePaneId = '';
      await addNewTab();
      return;
    }
  } else {
    state.activePaneId = firstPaneId(tab.root);
  }

  renderAll();
  setStatus('Terminal exited');
  saveWorkspaceSoon();
}

async function refreshRunningTerminals() {
  const list = await getJson('/api/terminals');
  const openIds = new Set([...state.panes.values()].map((p) => p.terminalId));
  const running = (list.terminals || []).filter((t) => t.status === 'running' && !openIds.has(t.id));

  for (const term of running) {
    createTabFromTerminal(term);
  }

  if (running.length === 0) {
    setStatus('No new running terminals to attach');
  } else {
    setStatus(`Attached ${running.length} terminal(s)`);
    saveWorkspaceSoon();
  }
}

loginFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  authErrorEl.textContent = '';

  try {
    await postJson('/api/auth/login', { password: passwordEl.value });
    setAuthenticated(true);
    setStatus('Authenticated');
    await loadServerConfig();
    await bootstrapTabsFromServer();
  } catch (error) {
    authErrorEl.textContent = error.message;
    passwordEl.focus();
  }
});

webCancelEl.addEventListener('click', () => {
  closeWebOverlay();
});

webFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  webErrorEl.textContent = '';
  if (!state.authenticated) return;
  try {
    await addNewWebTab(webUrlEl.value);
    closeWebOverlay();
  } catch (error) {
    webErrorEl.textContent = String(error && error.message ? error.message : error);
  }
});

newTabEl.addEventListener('click', async () => {
  try {
    await addNewTab();
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});

newWebEl.addEventListener('click', async () => {
  openWebOverlay('https://google.com/');
});

splitVEl.addEventListener('click', async () => {
  try {
    await splitActivePane('row');
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});

splitHEl.addEventListener('click', async () => {
  try {
    await splitActivePane('column');
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});

exitTerminalEl.addEventListener('click', async () => {
  try {
    await exitActiveTerminal();
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});

refreshEl.addEventListener('click', async () => {
  try {
    await refreshRunningTerminals();
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});

logoutEl.addEventListener('click', async () => {
  try {
    await postJson('/api/auth/logout', {});
  } catch {
    // no-op
  }

  clearWorkspaceState();
  setAuthenticated(false);
  setStatus('Locked');
  setMeta('Disconnected');
  passwordEl.focus();
});

window.addEventListener('resize', () => {
  for (const runtime of state.runtimes.values()) runtime.fit.fit();
});

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  handleFocusShortcut(event);
});

(async () => {
  setAuthenticated(false);
  setStatus('Checking auth...');

  try {
    const auth = await getJson('/api/auth/status');
    if (auth.authenticated) {
      setAuthenticated(true);
      setStatus('Authenticated');
      await loadServerConfig();
      await bootstrapTabsFromServer();
    } else {
      setAuthenticated(false);
      setStatus('Locked');
      passwordEl.focus();
    }
  } catch {
    setAuthenticated(false);
    setStatus('Service unavailable');
    passwordEl.focus();
  }
})();
