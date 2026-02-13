# TapTerm (Port 8049, Auth Required)

Authenticated web terminal plus a streamed host-browser pane (Playwright).

## What it does

- Password login is mandatory (`AUTH_PASSWORD`)
- Session cookie is `HttpOnly` + `SameSite=Strict`
- Browser terminal uses WebSocket (`/ws/terminal`)
- Multiple terminals in tabs; split panes vertically/horizontally
- Split sizes are draggable in the browser
- Terminals stay alive on the server until explicitly exited
- Workspace layout (tabs/splits) is shared and restored across browser logins
- Shell runs in `WORKDIR` (defaults to current project directory)
- Shell is PTY-backed via `script` + `${SHELL:-/bin/bash}`
- Web panes run Chromium on the host and stream frames to the client (`/ws/web`)

## Development (`npm run dev`)

```bash
AUTH_PASSWORD='dev-only-change-this' npm run dev
```

Open: `http://127.0.0.1:8049`

`npm run dev` defaults:
- `PORT=8049`

You must provide `AUTH_PASSWORD` in your environment (example above).

## Production-style local run

```bash
AUTH_PASSWORD='change-this-now' PORT=8049 npm start
```

Useful optional env vars:
- `HOST` default `127.0.0.1`
- `WORKDIR` default current directory
- `SESSION_TTL_MS` default `43200000` (12h)
- `TERMINAL_SHELL` override shell path
- `TERM_BUFFER_MAX_CHARS` default `200000` (output backlog sent on reattach)
- `WEB_MAX_SESSIONS` default `6` (max concurrent streamed browser sessions)
- `WEB_FPS` default `8` (stream framerate, jpeg screenshots)
- `WEB_JPEG_QUALITY` default `70` (jpeg quality, 30..90)

## API surface

- `GET /api/health`
- `GET /api/auth/status`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/terminal/config`
- `GET /api/workspace`
- `PUT /api/workspace`
- `GET /api/terminals`
- `POST /api/terminals`
- `POST /api/terminals/:id/exit`
- `WS /ws/terminal?terminalId=:id` (authenticated)
- `POST /api/web/sessions` (authenticated, creates a streamed browser session)
- `WS /ws/web?sessionId=:id` (authenticated, streams frames + accepts input)

## systemd service

1. Copy the example unit:

```bash
cp deploy/term-web-terminal.service.example deploy/term-web-terminal.service
```

2. Edit `deploy/term-web-terminal.service` and set a new strong password:

```ini
Environment=AUTH_PASSWORD=YOUR_STRONG_PASSWORD
```

3. Install and start:

```bash
sudo cp deploy/term-web-terminal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now term-web-terminal.service
sudo systemctl status term-web-terminal.service
```

4. If you previously installed the unit with an old password, update the unit file in `/etc/systemd/system/term-web-terminal.service` (or recopy it) and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart term-web-terminal.service
```

## Nginx proxy (HTTPS)

1. Copy config and edit domain:

```bash
sudo cp deploy/nginx-term-zeroact-dev.conf /etc/nginx/sites-available/term.zeroact.dev
sudo ln -s /etc/nginx/sites-available/term.zeroact.dev /etc/nginx/sites-enabled/term.zeroact.dev
```

2. Validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Proxy target: `127.0.0.1:8049`
