'use strict'
const crypto = require('crypto')
const { addonBuilder } = require('stremio-addon-sdk')
const pkg = require('../package.json')
const engine = require('./engine')
const { resolveSource, parseMagnet, normalizeInfoHash, playableFiles, formatBytes } = require('./torrent')

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_SEC || 15) * 1000
const DIRECT_METADATA_TIMEOUT_MS = Number(process.env.DIRECT_METADATA_TIMEOUT_SEC || 20) * 1000
const PLAY_SECRET = process.env.PLAY_SECRET || ''
const LOOP_HEADER = 'x-stremio-http-wrapper'
const ID_PREFIX = 'wtorrent:'

const manifest = {
  id: 'org.omar.stremio-http-wrapper',
  version: pkg.version,
  name: 'Migeloforreal',
  logo: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (process.env.SPACE_HOST ? 'https://' + process.env.SPACE_HOST : '')).replace(/\/+$/, '') + '/static/logo.png',
  description: '🎬 Migeloforreal turns every torrent and magnet link into a fast, smooth HTTP stream that plays in any app. Plug in your favourite add-ons, press play, and skip anywhere in the video instantly. No torrent client, no waiting, just watch.',
  resources: [
    'catalog',
    { name: 'meta', types: ['movie'], idPrefixes: [ID_PREFIX] },
    { name: 'stream', types: ['movie', 'series', 'anime', 'other'], idPrefixes: ['tt', 'kitsu', 'tmdb:', 'mal:', 'anilist:', 'anidb:', ID_PREFIX] }
  ],
  types: ['movie', 'series', 'anime', 'other'],
  catalogs: [{ type: 'movie', id: 'wrapper-my-torrents', name: 'Migeloforreal' }],
  behaviorHints: { configurable: true, configurationRequired: true },
  // Used by Stremio / the SDK to know the add-on has settings. Our own page at /configure handles them.
  config: [
    { key: 'addons', type: 'text', title: 'Manifest URLs of your torrent add-ons (one per line)' },
    { key: 'magnets', type: 'text', title: 'Magnet links / info hashes / .torrent URLs (one per line)' },
    { key: 'keepTorrent', type: 'checkbox', title: 'Also keep the original torrent streams' }
  ]
}

/* ---------------------------------------------------------------- helpers */

const b64 = s => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = s => Buffer.from(s, 'base64url').toString('utf8')

function signPlay (infoHash, fileIdx) {
  return crypto.createHmac('sha256', PLAY_SECRET).update(`${infoHash}/${fileIdx}`).digest('base64url').slice(0, 22)
}

function playUrl (base, infoHash, fileIdx, filename) {
  const idx = fileIdx === undefined || fileIdx === null || fileIdx === '' ? 'auto' : String(fileIdx)
  const name = encodeURIComponent((filename || 'video').replace(/[/\\]/g, '_'))
  let url = `${base}/play/${infoHash}/${idx}/${name}`
  if (PLAY_SECRET) url += '?sig=' + signPlay(infoHash, idx)
  return url
}

async function fetchJson (url, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', [LOOP_HEADER]: '1', 'user-agent': 'stremio-http-wrapper/' + pkg.version } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally { clearTimeout(timer) }
}

const manifestCache = new Map() // url -> { at, manifest|null }
async function upstreamManifest (url) {
  const hit = manifestCache.get(url)
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.manifest
  let m = null
  try { m = await fetchJson(url, 8000) } catch (_) {}
  manifestCache.set(url, { at: Date.now(), manifest: m })
  return m
}

/** Does an upstream manifest declare streams for this type/id? Unknown -> true (just try). */
function supportsStream (m, type, id) {
  if (!m || !Array.isArray(m.resources)) return true
  const r = m.resources.find(x => (x && x.name ? x.name : x) === 'stream')
  if (!r) return false
  const types = (typeof r === 'object' && r.types) || m.types
  const prefixes = (typeof r === 'object' && r.idPrefixes) || m.idPrefixes
  if (Array.isArray(types) && types.length && !types.includes(type)) return false
  if (Array.isArray(prefixes) && prefixes.length && !prefixes.some(p => id.startsWith(p))) return false
  return true
}

/** Extracts torrent info from a Stremio stream object, or null if it is not a torrent stream. */
function torrentOf (s) {
  if (s.infoHash) {
    const infoHash = normalizeInfoHash(s.infoHash)
    if (!infoHash) return null
    const trackers = (s.sources || []).filter(x => typeof x === 'string' && x.startsWith('tracker:')).map(x => x.slice(8))
    return { infoHash, fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : undefined, trackers }
  }
  if (typeof s.url === 'string' && /^magnet:\?/i.test(s.url)) {
    try {
      const m = parseMagnet(s.url)
      return { infoHash: m.infoHash, fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : undefined, trackers: m.trackers, torrentUrl: m.exactSources[0] }
    } catch (_) { return null }
  }
  return null
}

function convertStream (s, upstreamName, base) {
  const t = torrentOf(s)
  if (!t) return null
  engine.rememberTrackers(t.infoHash, t.trackers)
  if (t.torrentUrl) engine.rememberTorrentUrl(t.infoHash, t.torrentUrl)
  const bh = Object.assign({}, s.behaviorHints || {})
  bh.bingeGroup = 'httpwrap|' + (bh.bingeGroup || upstreamName)
  const out = {
    name: '⚡Migeloforreal\n' + (s.name || upstreamName),
    title: s.title || s.description || '',
    description: s.description || s.title || '',
    url: playUrl(base, t.infoHash, t.fileIdx, bh.filename),
    behaviorHints: bh
  }
  if (s.subtitles) out.subtitles = s.subtitles
  return out
}

/* ------------------------------------------------------- upstream wrapping */

async function wrapUpstreams (type, id, cfg, base) {
  const results = await Promise.all(cfg.addons.map(async (manifestUrl) => {
    const root = manifestUrl.replace(/\/manifest\.json$/i, '')
    const [m, data] = await Promise.all([
      upstreamManifest(manifestUrl),
      fetchJson(`${root}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id).replace(/%3A/gi, ':')}.json`).catch(err => ({ _err: err }))
    ])
    const name = (m && m.name) || new URL(manifestUrl).hostname
    if (m && !supportsStream(m, type, id)) return []
    if (data._err) { console.warn(`[wrap] ${name}: ${data._err.message}`); return [] }
    const streams = Array.isArray(data.streams) ? data.streams : []
    const out = []
    for (const s of streams) {
      if (!s || typeof s !== 'object') continue
      const converted = convertStream(s, name, base)
      if (converted) {
        out.push(converted)
        if (cfg.keepTorrent) out.push(s)
      } else {
        out.push(s) // HTTP / YouTube / external streams pass through unchanged
      }
    }
    return out
  }))
  return results.flat()
}

/* -------------------------------------------------------- direct magnets */

async function directStreams (source, base) {
  const info = await resolveSource(source)
  engine.rememberTrackers(info.infoHash, info.trackers)
  if (info.torrentUrl) engine.rememberTorrentUrl(info.infoHash, info.torrentUrl)
  let files = info.files
  if (!files) {
    // Ask the torrent engine for the file list (needs peers). If it takes too long, fall back to "largest file".
    try {
      const t = await engine.getTorrent(info.infoHash, { trackers: info.trackers, timeoutMs: DIRECT_METADATA_TIMEOUT_MS })
      files = t.files.map((f, idx) => ({ idx, name: f.name, path: f.path, length: f.length }))
    } catch (err) { console.warn('[direct] metadata not available yet:', err.message) }
  }
  const label = info.name || info.infoHash
  if (!files || !files.length) {
    return [{ name: '⚡Migeloforreal', title: label + '\n(largest file)', description: label + '\n(largest file)', url: playUrl(base, info.infoHash, 'auto', info.name), behaviorHints: { bingeGroup: 'httpwrap|' + info.infoHash } }]
  }
  return playableFiles(files).map(f => ({
    name: '⚡Migeloforreal',
    title: `${f.name}\n💾 ${formatBytes(f.length)}`,
    description: `${f.name}\n💾 ${formatBytes(f.length)}`,
    url: playUrl(base, info.infoHash, f.idx, f.name),
    behaviorHints: { bingeGroup: 'httpwrap|' + info.infoHash, filename: f.name, videoSize: f.length }
  }))
}

async function metaFor (source) {
  const id = ID_PREFIX + b64(source)
  try {
    const info = await resolveSource(source)
    const vids = playableFiles(info.files || [])
    const desc = [`Info hash: ${info.infoHash}`]
    if (vids.length) desc.push('Files: ' + vids.slice(0, 10).map(f => `${f.name} (${formatBytes(f.length)})`).join(', '))
    return { id, type: 'movie', name: info.name || ('Torrent ' + info.infoHash.slice(0, 8)), description: desc.join('\n'), posterShape: 'landscape' }
  } catch (err) {
    return { id, type: 'movie', name: 'Invalid torrent', description: err.message }
  }
}

/* ---------------------------------------------------------------- builder */

const builder = new addonBuilder(manifest)

// `config` is the decoded user config + `_base` (public URL of this server), added by server.js
builder.defineStreamHandler(async ({ type, id, config }) => {
  const cfg = config || {}
  if (cfg._loop) return { streams: [] }
  const base = cfg._base
  if (id.startsWith(ID_PREFIX)) {
    const streams = await directStreams(unb64(id.slice(ID_PREFIX.length)), base).catch(err => {
      console.warn('[direct]', err.message); return []
    })
    return { streams, cacheMaxAge: 0 }
  }
  if (!cfg.addons || !cfg.addons.length) return { streams: [] }
  return { streams: await wrapUpstreams(type, id, cfg, base), cacheMaxAge: 0 }
})

builder.defineCatalogHandler(async ({ id, config }) => {
  if (id !== 'wrapper-my-torrents') return { metas: [] }
  const sources = (config && config.magnets) || []
  return { metas: await Promise.all(sources.map(metaFor)), cacheMaxAge: 0 }
})

builder.defineMetaHandler(async ({ id }) => {
  if (!id.startsWith(ID_PREFIX)) return { meta: null }
  return { meta: await metaFor(unb64(id.slice(ID_PREFIX.length))) }
})

module.exports = { addonInterface: builder.getInterface(), manifest, signPlay, PLAY_SECRET, LOOP_HEADER }
