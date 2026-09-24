
# Install & deploy

[← Back to README](../README.md) · [Documentation index](../README.md)

Everything about getting FreeLLMAPI running: the one-liner, Docker Compose, local development, declarative config, production builds, where your data lives, and how to reset a password, read the logs, or uninstall.

- [Quick start (one-liner)](#quick-start-one-liner)
- [Docker Compose](#docker-compose)
- [Local development](#local-development)
- [Declarative startup config](#declarative-startup-config)
- [Docker image & operations](#docker-image--operations)
- [Credentials and where your data lives](#credentials-and-where-your-data-lives)
- [FAQ: passwords, logs, uninstall](#faq-passwords-logs-uninstall)

## Quick start (one-liner)

Docker required — sets up `~/freellmapi`, generates an encryption key, pulls the image, and starts the container:

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

Prefer to read before you pipe to bash? [The script is here](https://freellmapi.co/install.sh). Re-running it is safe: your `.env` (and encryption key) is preserved and the container updates to `:latest`. Override the defaults with `FREELLMAPI_DIR`, `PORT`, or `HOST_BIND` env vars.

On Windows, the Docker steps work in WSL or any bash shell; for a non-Docker setup, use local development (`npm run dev`).

On Android, see the experimental [Termux installation guide](02-android-termux.md). It uses Node's built-in SQLite driver and does not require the Android NDK.

Open http://localhost:3001, add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

Your install keeps itself updated from the signed catalog feed. The current full catalog is listed at [freellmapi.co/models](https://freellmapi.co/models.html).

## Docker Compose

Runs the API and dashboard together on port 3001 and persists SQLite in a named volume.

**Prerequisites:** Docker, Docker Compose, OpenSSL.

*On macOS / Linux (Bash):*
```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

# Generate an encryption key for at-rest key storage
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

docker compose up -d
```

*On Windows (PowerShell):*
```powershell
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

$Bytes = New-Object Byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($Bytes)
$ENCRYPTION_KEY = -join ($Bytes | ForEach-Object { "{0:x2}" -f $_ })
"ENCRYPTION_KEY=$ENCRYPTION_KEY`nPORT=3001" | Out-File -Encoding utf8 .env
docker compose up -d
```

> **Reaching it from another machine?** By default the container is published only on `127.0.0.1`, so `http://<server-ip>:3001` won't load from another device (the page just hangs). To expose it on your LAN — e.g. a Raspberry Pi at `http://192.168.1.x:3001` — start it with `HOST_BIND=0.0.0.0`:
>
> ```bash
> HOST_BIND=0.0.0.0 docker compose up -d
> ```
>
> Only do this on a trusted network: the proxy is single-user and guarded only by the unified API key.

> **Providers unreachable from the container, but fine from the host?** A container has its own network stack, so two things that work on your machine do not carry over:
>
> - **A proxy on `127.0.0.1` is not your machine.** Inside the container, loopback is the container itself. If you reach providers through a proxy client on the host (Clash, v2rayN, sing-box, a corporate proxy), point FreeLLMAPI at the host instead: `PROXY_URL=socks5h://host.docker.internal:7890`. The bundled `docker-compose.yml` maps `host.docker.internal` to the host gateway, so this works on plain Linux Docker as well as Docker Desktop. The proxy also has to accept connections from outside loopback (in Clash, `allow-lan: true`).
> - **An IPv6-only host needs IPv6 enabled in Docker.** The default bridge network is IPv4-only, so on a host with no IPv4 route the container cannot reach anything, DNS included. Enable it in `/etc/docker/daemon.json` with `"ipv6": true`, `"ip6tables": true` and a `"fixed-cidr-v6"` range, then restart Docker.
>
> To see which of these you are hitting, ask the container directly:
>
> ```bash
> docker compose exec freellmapi node -e "fetch('https://generativelanguage.googleapis.com/').then(r=>console.log('ok',r.status)).catch(e=>console.log('fail',e.cause?.code||e.message))"
> ```

## Local development

**Prerequisites:** Node.js 20+, npm.

*On macOS / Linux (Bash):*
```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
npm run dev
```

*On Windows (PowerShell):*
```powershell
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install
$ENCRYPTION_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
"ENCRYPTION_KEY=$ENCRYPTION_KEY`nPORT=3001" | Out-File -Encoding utf8 .env
npm run dev
```

`ENCRYPTION_KEY` is required for startup. When `NODE_ENV` is not `production`
and it is unset, the server auto-generates a development key and saves it to a
`.encryption-key` file (0600) next to the SQLite database, not inside it. Older
installs that kept the key in the database are migrated to this file on first
boot. Do not rely on that fallback with real provider keys; set `ENCRYPTION_KEY`.

### Rotating the encryption key

Stored secrets are AES-256-GCM, so simply changing `ENCRYPTION_KEY` does not
re-encrypt anything — it makes every provider key, per-key proxy override,
client-profile credential and saved Fetch Relay token fail to decrypt at once.
Re-encrypt them first, with the server stopped:

```bash
# 1. Generate the new key
NEW_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"

# 2. Preview (reads only, writes nothing)
cd server
ENCRYPTION_KEY=<old key> npm run rotate-encryption-key -- \
  --new-key "$NEW_KEY" --dry-run

# 3. Rotate for real
ENCRYPTION_KEY=<old key> npm run rotate-encryption-key -- --new-key "$NEW_KEY"
```

`--old-key <hex>` overrides the key read from `ENCRYPTION_KEY`, and
`--db <path>` points at a database somewhere other than `server/data`. Nothing
is written unless every value decrypts, so a wrong old key aborts with a
non-zero exit and an untouched database.

Then put the new key in `.env` (`ENCRYPTION_KEY=$NEW_KEY`) and restart. Under
Docker, run the command inside the container against the mounted database and
restart the container with the updated `.env`. Take a copy of the database file
before rotating.

Request analytics are retained for 90 days or 100000 request rows by default,
whichever limit prunes first. Set `REQUEST_ANALYTICS_RETENTION_DAYS=0` or
`REQUEST_ANALYTICS_MAX_ROWS=0` in `.env` to disable either retention limit.

Open http://localhost:5173 (the Vite dev UI), add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

> **Reaching the dev UI from another device on your LAN?** Use `npm run dev:lan` — it passes `--host` through to Vite, which then prints a `Network: http://<your-ip>:5173` URL you can open from a phone or another machine. (Plain `npm run dev -- --host` does *not* work here: the root `dev` script is a `concurrently` wrapper, so the flag never reaches Vite.) API calls go through Vite's dev proxy, so no extra server config is needed.

For a production build without Docker:

```bash
npm run build
node server/dist/index.js     # server + dashboard both served on :3001
```

## Declarative startup config

For repeatable Docker/server installs, FreeLLMAPI can apply a JSON config on
every boot. Set `FREEAPI_CONFIG_PATH=/path/to/freellmapi.config.json` or put the
same JSON in `FREEAPI_CONFIG_JSON`. The config is idempotent: existing keys,
custom providers, model edits, fallback rows, and routing settings are updated
instead of duplicated.

```json
{
  "keys": [
    { "platform": "groq", "key": "gsk_...", "label": "main" },
    { "platform": "google", "key": "AIza...", "enabled": true }
  ],
  "customProviders": [
    {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "label": "Ollama",
      "models": [
        { "model": "llama3.1:8b", "displayName": "Local Llama", "supportsTools": true }
      ]
    }
  ],
  "models": [
    {
      "platform": "groq",
      "modelId": "llama-3.3-70b-versatile",
      "displayName": "Llama 3.3 70B",
      "supportsTools": true,
      "fallbackEnabled": true
    }
  ],
  "routing": { "strategy": "balanced" }
}
```

If two custom endpoints serve the same model id, add `"endpoint"` to a `models`
or `fallback` entry to say which one you mean — the endpoint's URL, or the short
handle the dashboard shows next to it. Without it, an entry that matches more
than one endpoint is rejected rather than applied to an arbitrary one:

```json
{
  "models": [
    { "platform": "custom", "modelId": "deepseek-v3.1", "endpoint": "https://relay-b.example.com/v1", "enabled": false }
  ]
}
```

## Docker image & operations

FreeLLMAPI publishes a single production image that contains the Express server and the built React dashboard:

```bash
docker pull ghcr.io/tashfeenahmed/freellmapi:latest   # or pin a release, e.g. :v1.2.3
```

The image is multi-arch (`linux/amd64` + `linux/arm64`, so it runs on a Raspberry Pi). Published tags: `latest` (default branch), `v*.*.*` (git release tags), and `sha-<commit>`.

The included `docker-compose.yml` is the recommended install path:

```bash
docker compose up -d
docker compose logs -f freellmapi
```

By default the container's port is bound to `127.0.0.1` (localhost only). To reach the dashboard/API from another machine on your network, publish it on all interfaces with `HOST_BIND=0.0.0.0 docker compose up -d` — only on a trusted LAN, since the proxy is single-user.

Plain HTTP over a LAN address works as-is: the security headers that only apply to HTTPS (`upgrade-insecure-requests`, `Cross-Origin-Opener-Policy`, `Origin-Agent-Cluster`) are emitted only when the request actually arrived over TLS — or over loopback, which browsers already treat as a secure context. Behind an HTTPS reverse proxy they come back on automatically, as long as the proxy forwards `X-Forwarded-Proto`. `CSP_UPGRADE_INSECURE_REQUESTS=true|false` overrides the upgrade directive if your setup needs it.

SQLite data is stored in the `freellmapi-data` volume at `/app/server/data`.
Keep the same `.env` `ENCRYPTION_KEY` and volume when upgrading, because
provider keys are encrypted at rest. If your host only persists a specific
directory, set `FREEAPI_DB_PATH=/that/path/freellmapi.db`.

On hosts with ephemeral disks, configure an encrypted backup target:

```env
FREEAPI_DB_BACKUP_PATH=/app/server/data/freellmapi.db.backup
# or:
FREEAPI_DB_BACKUP_URL=https://example.com/freellmapi.db.backup
FREEAPI_DB_BACKUP_TOKEN=optional-bearer-token
FREEAPI_DB_BACKUP_KEY=64-char-hex-backup-key
FREEAPI_DB_BACKUP_INTERVAL_MS=300000
```

When the database file is missing at startup, FreeLLMAPI restores the backup
before migrations run. While the server is running it uploads a fresh encrypted
backup periodically. If `FREEAPI_DB_BACKUP_KEY` is omitted, the app uses
`ENCRYPTION_KEY` for the backup envelope too.

More Docker operations and examples live in [docker/README.md](../../../docker/README.md).

## Credentials and where your data lives

The only credential your apps need is your **unified API key** — the
`freellmapi-…` token your OpenAI/Anthropic client points at. Grab it from the
dashboard **Keys** page header.

The dashboard itself is gated by an **email + password account**, created on
your first visit to the dashboard.

You do not need to open or edit the SQLite database by hand. Your settings and
data live in two places:

- the `.env` file (encryption key, port, bind address, other settings), and
- the SQLite DB at `server/data/freeapi.db` (all keys, models, settings,
  encrypted at rest) — or wherever `FREEAPI_DB_PATH` points. Under Docker it is
  the `freellmapi-data` volume at `/app/server/data`.

Copy those two to migrate an install to another machine or into a container.

## FAQ: passwords, logs, uninstall

### I forgot my dashboard password

Every install (Docker, one-liner, `npm run dev`) has an email + password
account, and there is no email delivery to send a reset link to. The
flow is a one-time code printed to the server log:

1. On the login page, click **Forgot password?**, then **Send reset code**.
2. Read the code from the server log (see below). It looks like this:

   ```
     Password-reset code: HWNHPU5QGZ
     Enter this code on the reset form to set a new password.
   ```

3. Type it into the reset form together with your new password.

The code is valid for **15 minutes**, and requesting a new one invalidates the
previous code. Requests are rate-limited, so ask for one code and wait for it
rather than clicking repeatedly.

### Where are the logs?

| Install method | Where the log goes |
|----------------|--------------------|
| Docker Compose | `docker compose logs -f freellmapi` |
| Plain Docker | `docker logs -f <container>` (`docker ps` lists the name) |
| One-liner install | `cd ~/freellmapi && docker compose logs -f freellmapi` |
| `npm run dev` / `node server/dist/index.js` | the terminal the server is running in |

### How do I uninstall?

Removing the app never removes your data directory — deleting that is a
separate, deliberate step, which is also what makes it safe to reinstall over
the top.

**Docker**

```bash
docker compose down -v            # -v also drops the freellmapi-data volume
docker image rm ghcr.io/tashfeenahmed/freellmapi:latest
rm -rf ~/freellmapi               # the one-liner's directory: .env + compose file
```

Leave off `-v` if you want to keep the database for a later reinstall.

**From source** — delete the checkout. The state that matters is `.env` and
`server/data/freeapi.db` (or wherever `FREEAPI_DB_PATH` points), so back those
up first if you plan to come back.
