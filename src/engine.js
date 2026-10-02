'use strict'
/**
 * Torrent engine (WebTorrent) used by the /play endpoint.
 *  - one shared WebTorrent client
 *  - torrents are added "deselected": only the pieces you actually watch are downloaded
 *  - data is stored in CACHE_DIR/<infoHash>
 *  - idle torrents (no open HTTP stream for IDLE_TIMEOUT_MIN) are destroyed and their cache deleted
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DEFAULT_TRACKERS, playableFiles, fetchTorrentBuffer, parseTorrentFile } = require('./torrent')

const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(os.tmpdir(), 'stremio-http-wrapper'))
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MIN || 10) * 60 * 1000
const MAX_TORRENTS = Number(process.env.MAX_TORRENTS || 5)
const METADATA_TIMEOUT_MS = Number(process.env.METADATA_TIMEOUT_SEC || 60) * 1000
const KEEP_CACHE = process.env.KEEP_CACHE === '1' || process.env.KEEP_CACHE === 'true'
const MAX_CONNS = Number(process.env.MAX_CONNS || 55)
const TORRENT_PORT = Number(process.env.TORRENT_PORT || 0) // 0 = random; set + open it in your firewall for more peers

let clientPromise = null
const entries = new Map() // infoHash -> { torrent, ready: Promise, lastUsed, active, trackers }
const knownTrackers = new Map() // infoHash -> [trackers] (remembered from upstream streams)
const knownTorrentUrls = new Map() // infoHash -> http(s) URL of the .torrent file (gives instant metadata + web seeds)

function getClient () {
  if (!clientPromise) {
    clientPromise = import('webtorrent').then(({ default: WebTorrent }) => {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      const client = new WebTorrent({ maxConns: MAX_CONNS, utp: false, lsd: false, webSeeds: true, torrentPort: TORRENT_PORT })
      client.on('error', err => console.error('[engine] client error:', err.message))
      return client
    })
  }
  return clientPromise
}

function rememberTrackers (infoHash, trackers) {
  if (!trackers || !trackers.length) return
  const cur = knownTrackers.get(infoHash) || []
  trackers.forEach(t => { if (!cur.includes(t)) cur.push(t) })
  knownTrackers.set(infoHash, cur.slice(0, 50))
  if (knownTrackers.size > 5000) knownTrackers.delete(knownTrackers.keys().next().value)
}

function rememberTorrentUrl (infoHash, url) {
  if (!url) return
  knownTorrentUrls.set(infoHash, url)
  if (knownTorrentUrls.size > 5000) knownTorrentUrls.delete(knownTorrentUrls.keys().next().value)
}

/** If we know a .torrent URL for this hash, download it (metadata without waiting for peers). */
async function torrentInputFor (infoHash, opts) {
  const url = knownTorrentUrls.get(infoHash)
  if (url) {
    try {
      const buf = await fetchTorrentBuffer(url)
      if (parseTorrentFile(buf).infoHash === infoHash) return buf
    } catch (err) { console.warn('[engine] could not fetch .torrent', url, err.message) }
  }
  const extra = (opts.webSeeds || []).map(w => '&ws=' + encodeURIComponent(w)).join('')
  return magnetFor(infoHash, opts.trackers || [], extra)
}

function magnetFor (infoHash, extraTrackers = [], extraParams = '') {
  const trackers = [...new Set([...(knownTrackers.get(infoHash) || []), ...extraTrackers, ...DEFAULT_TRACKERS])]
  return 'magnet:?xt=urn:btih:' + infoHash + trackers.map(t => '&tr=' + encodeURIComponent(t)).join('') + extraParams
}

async function evictIfNeeded () {
  if (entries.size < MAX_TORRENTS) return
  const idle = [...entries.entries()].filter(([, e]) => e.active === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  while (entries.size >= MAX_TORRENTS && idle.length) await removeTorrent(idle.shift()[0], 'max torrents reached')
}

/** Get (or start) a torrent and wait until its metadata (file list) is known. */
async function getTorrent (infoHash, opts = {}) {
  infoHash = infoHash.toLowerCase()
  let e = entries.get(infoHash)
  if (!e) {
    await evictIfNeeded()
    const client = await getClient()
    const input = await torrentInputFor(infoHash, opts)
    e = entries.get(infoHash) // re-check after awaits
    if (!e) {
      const torrent = client.add(input, {
        path: path.join(CACHE_DIR, infoHash),
        deselect: true,
        destroyStoreOnDestroy: !KEEP_CACHE
      })
      torrent.on('error', err => console.error(`[engine] torrent ${infoHash} error: ${err.message}`))
      torrent.on('warning', () => {})
      e = { torrent, lastUsed: Date.now(), active: 0 }
      e.ready = new Promise((resolve, reject) => {
        if (torrent.ready) return resolve(torrent)
        const timer = setTimeout(() => reject(new Error('Timed out waiting for torrent metadata (no peers?)')), opts.timeoutMs || METADATA_TIMEOUT_MS)
        torrent.once('ready', () => { clearTimeout(timer); resolve(torrent) })
        torrent.once('error', err => { clearTimeout(timer); reject(err) })
      })
      e.ready.then(t => {
        // make sure nothing is downloaded unless a stream asks for it
        try { t.files.forEach(f => f.deselect()) } catch (_) {}
        console.log(`[engine] ready ${infoHash} "${t.name}" (${t.files.length} files)`)
      }).catch(err => {
        console.error(`[engine] ${infoHash}: ${err.message}`)
        removeTorrent(infoHash, 'failed')
      })
      entries.set(infoHash, e)
      console.log('[engine] added', infoHash)
    }
  }
  e.lastUsed = Date.now()
  return e.ready
}

/** fileIdx: number or 'auto' (largest video file) */
function pickFile (torrent, fileIdx) {
  if (fileIdx !== 'auto' && fileIdx !== undefined && fileIdx !== null && fileIdx !== '') {
    const f = torrent.files[Number(fileIdx)]
    if (!f) throw Object.assign(new Error('fileIdx out of range'), { status: 404 })
    return f
  }
  const files = torrent.files.map((f, idx) => ({ idx, name: f.name, length: f.length }))
  const best = playableFiles(files)[0]
  if (!best) throw Object.assign(new Error('Torrent has no files'), { status: 404 })
  return torrent.files[best.idx]
}

function markActive (infoHash, delta) {
  const e = entries.get(infoHash)
  if (!e) return
  e.active = Math.max(0, e.active + delta)
  e.lastUsed = Date.now()
}

async function removeTorrent (infoHash, reason) {
  const e = entries.get(infoHash)
  if (!e) return
  entries.delete(infoHash)
  console.log(`[engine] removing ${infoHash} (${reason})`)
  await new Promise(resolve => {
    try { e.torrent.destroy({ destroyStore: !KEEP_CACHE }, () => resolve()) } catch (_) { resolve() }
  })
  if (!KEEP_CACHE) fs.rm(path.join(CACHE_DIR, infoHash), { recursive: true, force: true }, () => {})
}

function cleanupIdle () {
  const now = Date.now()
  for (const [hash, e] of entries) {
    if (e.active === 0 && now - e.lastUsed > IDLE_TIMEOUT_MS) removeTorrent(hash, 'idle')
  }
}
const cleanupTimer = setInterval(cleanupIdle, Number(process.env.CLEANUP_INTERVAL_SEC || 60) * 1000)
cleanupTimer.unref()

/** On start-up, delete cache folders left over from a previous run (unless KEEP_CACHE). */
function cleanCacheDirOnStart () {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  if (KEEP_CACHE) return
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (/^[0-9a-f]{40}$/.test(name)) fs.rmSync(path.join(CACHE_DIR, name), { recursive: true, force: true })
  }
}

function stats () {
  return {
    cacheDir: CACHE_DIR,
    idleTimeoutMin: IDLE_TIMEOUT_MS / 60000,
    maxTorrents: MAX_TORRENTS,
    torrents: [...entries.entries()].map(([hash, e]) => {
      const t = e.torrent
      return {
        infoHash: hash,
        name: t.name || null,
        ready: !!t.ready,
        activeStreams: e.active,
        idleSec: Math.round((Date.now() - e.lastUsed) / 1000),
        peers: t.numPeers,
        downloaded: t.downloaded,
        downloadSpeed: t.downloadSpeed,
        uploadSpeed: t.uploadSpeed
      }
    })
  }
}

async function shutdown () {
  for (const hash of [...entries.keys()]) await removeTorrent(hash, 'shutdown')
  if (clientPromise) { const c = await clientPromise; await new Promise(r => c.destroy(() => r())) }
}

module.exports = { getTorrent, pickFile, markActive, rememberTrackers, rememberTorrentUrl, cleanCacheDirOnStart, stats, shutdown, CACHE_DIR }
