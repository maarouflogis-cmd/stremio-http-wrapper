# HTTP Torrent Wrapper – a Stremio add-on

This add-on sits **in front of your other torrent add-ons**.

* You give it the manifest URLs of the add-ons you already use (the ones that return torrent / magnet streams).
* When Stremio asks for streams, the wrapper asks those add-ons, takes every **torrent or magnet** stream,
  and changes it into a **normal HTTP link** on this server: `https://your-server/play/<infoHash>/<fileIdx>/<name>`.
* When the player opens that link, the server downloads the torrent (WebTorrent engine) and sends the video
  over HTTP, with **seeking** (HTTP Range / `206 Partial Content`) and the right `Content-Type`.
* Streams that are already HTTP (or YouTube, etc.) are passed through unchanged.
* You can also paste your **own magnet links / info hashes / .torrent URLs**. They show up in
  Discover → Movies → **"My torrents (HTTP)"**.

Why? Devices or apps that cannot play torrents (some TVs, web player, external players, slow phones) can play
plain HTTP. The torrent work is done by your server, not by the device.

> ⚠️ **The server does the downloading.** Run it on a machine with good bandwidth (upload *and* download) and some
> free disk (a few GB). Every person watching = one torrent downloading on the server and the video uploaded again to
> the viewer. A cheap VPS with 1 vCPU / 1 GB RAM / 20 GB disk is fine for 1–3 viewers.

This project only *reads* torrents you or your add-ons give it. It has no search engine / indexer and contains no
media. Only use it with content you have the right to watch.

---

## 1. Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer (20 recommended).

```bash
npm install
npm start
```

You will see:

```
HTTP wrapper add-on running: http://127.0.0.1:7000/manifest.json
Configure page:              http://127.0.0.1:7000/configure
```

* Local install URL: **http://127.0.0.1:7000/manifest.json**
* Settings page: **http://127.0.0.1:7000/configure**

## 2. Configure and install in Stremio

1. Open **http://127.0.0.1:7000/configure** in your browser
   (or in Stremio: Add-ons → search box → paste `http://127.0.0.1:7000/manifest.json` → **Configure**).
2. Box 1 – paste the **manifest URLs of your torrent add-ons**, one per line.
   To get one: in Stremio go to *Add-ons*, open the add-on and use *Share / Copy link*. It ends with `/manifest.json`.
   `stremio://...` links also work.
3. Box 2 (optional) – paste **magnet links, info hashes or `.torrent` URLs**, one per line.
4. (Optional) tick *"Also show the original torrent streams"* if you want both versions in the list.
5. Click **Generate install link**, then **Install in Stremio** (desktop app) or **Install in Stremio Web**,
   or **Copy URL** and paste it in Stremio → Add-ons → search box.

Your settings are saved **inside the URL** (`https://server/<settings>/manifest.json`, base64url text).
There is no account and no database. To change settings: Stremio → Add-ons → this add-on → **Configure**
(the page opens already filled), generate a new link and install it again.

Now open any movie or episode: streams from your torrent add-ons appear again with **⚡HTTP** in the name.
Stremio already combines all installed add-ons, so this works next to everything else you have. Tip: if you
don't want to see the torrent streams twice, you can uninstall the original torrent add-on from Stremio – the
wrapper calls it directly using the URL you pasted.

### Paste a magnet (direct option)

Put the magnet in box 2 of the configure page, install, then go to **Discover → Movies → "My torrents (HTTP)"**.
Open the item and press play. Supported inputs:

* `magnet:?xt=urn:btih:<hash>&dn=<name>&tr=<tracker>...` (hex or base32 hash)
* a bare info hash: 40 hex characters or 32 base32 characters
* an `http(s)://.../file.torrent` link (the file list is read from it; you get one stream per video file, biggest first)

For plain magnets the server asks the swarm for the file list (up to 20 s). If that is too slow you get one stream
that plays the biggest video file.

## 3. Put it online (phone / TV / other devices)

`127.0.0.1` only works on the same computer. For your phone or TV, run the wrapper on a server.
Stremio wants **HTTPS** for add-ons that are not on localhost, so put a HTTPS proxy in front.

### Option A – VPS with Docker (recommended)

On a VPS (Hetzner, OVH, DigitalOcean, Contabo…) with Docker installed and a domain pointing to it:

```bash
# copy this folder to the server, then:
docker build -t stremio-http-wrapper .
docker run -d --name wrapper --restart unless-stopped \
  -p 7000:7000 -p 6881:6881 -p 6881:6881/udp \
  -e PUBLIC_URL=https://addon.example.com \
  -e PLAY_SECRET=$(openssl rand -hex 16) \
  -v wrapper-cache:/cache \
  stremio-http-wrapper
```

(or edit `docker-compose.yml` and run `docker compose up -d --build`)

HTTPS with [Caddy](https://caddyserver.com) (gets a free certificate by itself) – `/etc/caddy/Caddyfile`:

```
addon.example.com {
    reverse_proxy 127.0.0.1:7000
}
```

Then open `https://addon.example.com/configure`, generate your link and install it on every device
(desktop, Android, Android TV, iPhone via Stremio Web…). The same URL works everywhere.

### Option B – VPS without Docker

```bash
npm install --omit=dev
PUBLIC_URL=https://addon.example.com PLAY_SECRET=some-long-random-text npm start
```

Use `pm2` or a `systemd` service to keep it running, and Caddy/nginx for HTTPS as above.

### What about Render / Beamup / free hosts?

They are made for small JSON add-ons, not for video. Free plans usually have little bandwidth, no lasting disk,
sleep when idle and sometimes block BitTorrent. The add-on part will run, but playback will be slow or break.
Use a real VPS (or a home computer/NAS with a port opened) for this wrapper.

## 4. Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `7000` | HTTP port |
| `PUBLIC_URL` | auto (from request) | Public address used in `/play` links, e.g. `https://addon.example.com` |
| `PLAY_SECRET` | empty | If set, `/play` links are signed, so strangers can't use your server to download other torrents. **Set it on public servers.** Also protects `/stats` (`/stats?key=<secret>`). |
| `CACHE_DIR` | `<tmp>/stremio-http-wrapper` | Where torrent data is stored (one folder per torrent) |
| `IDLE_TIMEOUT_MIN` | `10` | A torrent with no open stream for this long is stopped and its files deleted |
| `CLEANUP_INTERVAL_SEC` | `60` | How often the idle check runs |
| `MAX_TORRENTS` | `5` | Max torrents at once (oldest idle one is removed first) |
| `KEEP_CACHE` | off | `1` = keep downloaded data on disk after a torrent is stopped |
| `METADATA_TIMEOUT_SEC` | `60` | How long `/play` waits to get the torrent's file list from peers |
| `TORRENT_PORT` | random (`6881` in Docker) | BitTorrent listening port; open it in the firewall for more peers |
| `MAX_CONNS` | `55` | Max peer connections per torrent |
| `UPSTREAM_TIMEOUT_SEC` | `15` | Timeout when asking your other add-ons for streams |

Only the parts of the file you actually watch are downloaded (plus a small read-ahead), not the whole torrent.

## 5. Endpoints

| URL | |
|---|---|
| `/configure` | settings page |
| `/manifest.json` | base manifest (asks for configuration) |
| `/<config>/manifest.json` | your personal manifest |
| `/<config>/stream/<type>/<id>.json` | wrapped streams (`tt…` IMDb, `kitsu:…`, `tmdb:…`, `mal:…`, `anilist:…`, `anidb:…` ids) |
| `/<config>/catalog/movie/wrapper-my-torrents.json` | your pasted magnets |
| `/play/<infoHash>/<fileIdx or auto>/<name>` | the video over HTTP (GET/HEAD, Range supported) |
| `/stats` | running torrents, peers, speed |
| `/health` | health check |

## 6. Test

```bash
npm test
```

This starts a small fake add-on (`test/mock-upstream.js`) that returns the free Blender movies *Sintel* and
*Big Buck Bunny* (WebTorrent demo torrents), starts the wrapper, and checks: manifest, configure page, stream
conversion, HTTP pass-through, `/play` with Range (206), seeking, 416 errors, direct magnets, signed links and idle
cleanup. It needs internet and BitTorrent access.

## 7. Limits

* The server's internet speed is the limit. A torrent with few seeders will be slow to start or buffer.
* MKV/HEVC files are sent as they are (no transcoding). Stremio's own player usually handles them; a TV browser may not.
* Settings live in the URL: anyone who has your add-on URL can see the add-on URLs and magnets you configured.
* If `PLAY_SECRET` changes, old `/play` links stop working (Stremio asks for fresh links when you press play, so normally you won't notice).
* Only BitTorrent v1 info hashes (`btih`) are supported, not v2-only (`btmh`) torrents.
* Multi-range requests (`bytes=0-1,5-6`) get only the first range.
