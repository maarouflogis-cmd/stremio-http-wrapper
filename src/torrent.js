'use strict'
/**
 * Torrent / magnet helpers (no external dependencies).
 *  - parse magnet links (xt=urn:btih, dn, tr, xs/as)
 *  - normalise hex (40 chars) and base32 (32 chars) info hashes
 *  - decode bencoded .torrent files and compute the info hash (SHA-1 of the "info" dict)
 *  - fetch a .torrent from a URL and list its files
 */
const crypto = require('crypto')

// A few well known public trackers, only used when a source has no trackers of its own.
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'wss://tracker.openwebtorrent.com'
]

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|webm|mpg|mpeg|ts|m2ts|flv|ogv|3gp|vob|divx|xvid)$/i
const MAX_TORRENT_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = Number(process.env.TORRENT_FETCH_TIMEOUT_MS || 10000)

/* ---------------------------------------------------------------- info hash */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32ToHex (str) {
  const s = str.toUpperCase().replace(/=+$/, '')
  let bits = ''
  for (const ch of s) {
    const v = B32.indexOf(ch)
    if (v < 0) throw new Error('Invalid base32 character: ' + ch)
    bits += v.toString(2).padStart(5, '0')
  }
  let hex = ''
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex.slice(0, 40)
}

/** Returns a lowercase 40-char hex info hash, or null if the string is not a v1 info hash. */
function normalizeInfoHash (str) {
  if (!str) return null
  const s = String(str).trim()
  if (/^[0-9a-f]{40}$/i.test(s)) return s.toLowerCase()
  if (/^[A-Z2-7]{32}$/i.test(s)) return base32ToHex(s)
  return null
}

/* ------------------------------------------------------------------- magnet */

function parseMagnet (uri) {
  const str = String(uri).trim()
  if (!/^magnet:\?/i.test(str)) throw new Error('Not a magnet link')
  const query = str.slice(str.indexOf('?') + 1)
  const out = { infoHash: null, name: null, trackers: [], exactSources: [] }
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase().replace(/\.\d+$/, '') // xt.1 -> xt
    let val = eq < 0 ? '' : part.slice(eq + 1)
    try { val = decodeURIComponent(val.replace(/\+/g, ' ')) } catch (e) { /* keep raw */ }
    if (key === 'xt') {
      const m = val.match(/^urn:btih:(.+)$/i)
      if (m && !out.infoHash) out.infoHash = normalizeInfoHash(m[1])
    } else if (key === 'dn') {
      out.name = val
    } else if (key === 'tr') {
      if (val && !out.trackers.includes(val)) out.trackers.push(val)
    } else if (key === 'xs' || key === 'as') {
      if (/^https?:\/\//i.test(val)) out.exactSources.push(val)
    }
  }
  if (!out.infoHash) throw new Error('Magnet link has no valid xt=urn:btih info hash')
  return out
}

/* ---------------------------------------------------------------- bencode */

function bdecode (buf) {
  let pos = 0
  let infoStart = -1
  let infoEnd = -1
  function next (depth) {
    const c = buf[pos]
    if (c === 0x69) { // i<int>e
      const end = buf.indexOf(0x65, pos)
      if (end < 0) throw new Error('bad int')
      const n = Number(buf.toString('ascii', pos + 1, end))
      pos = end + 1
      return n
    }
    if (c === 0x6c) { // l...e
      pos++
      const list = []
      while (buf[pos] !== 0x65) { if (pos >= buf.length) throw new Error('bad list'); list.push(next(depth + 1)) }
      pos++
      return list
    }
    if (c === 0x64) { // d...e
      pos++
      const dict = {}
      while (buf[pos] !== 0x65) {
        if (pos >= buf.length) throw new Error('bad dict')
        const key = next(depth + 1).toString('utf8')
        const valStart = pos
        dict[key] = next(depth + 1)
        if (depth === 0 && key === 'info') { infoStart = valStart; infoEnd = pos }
      }
      pos++
      return dict
    }
    if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = buf.indexOf(0x3a, pos)
      const len = Number(buf.toString('ascii', pos, colon))
      const start = colon + 1
      if (start + len > buf.length) throw new Error('bad string length')
      pos = start + len
      return buf.subarray(start, start + len)
    }
    throw new Error('Invalid bencode at byte ' + pos)
  }
  const value = next(0)
  return { value, infoBuf: infoStart >= 0 ? buf.subarray(infoStart, infoEnd) : null }
}

const str = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : b == null ? '' : String(b))

/** Parse a .torrent file buffer -> { infoHash, name, trackers, files:[{idx,name,path,length}] } */
function parseTorrentFile (buf) {
  const { value, infoBuf } = bdecode(buf)
  if (!value || !value.info || !infoBuf) throw new Error('Not a valid .torrent file (no info dictionary)')
  const info = value.info
  const infoHash = crypto.createHash('sha1').update(infoBuf).digest('hex')
  const name = str(info['name.utf-8'] || info.name)
  const trackers = []
  const addTr = (t) => { const s = str(t); if (s && !trackers.includes(s)) trackers.push(s) }
  if (Array.isArray(value['announce-list'])) value['announce-list'].forEach(tier => (Array.isArray(tier) ? tier : [tier]).forEach(addTr))
  if (value.announce) addTr(value.announce)

  let files
  if (Array.isArray(info.files)) {
    files = info.files.map((f, idx) => {
      const parts = (f['path.utf-8'] || f.path || []).map(str)
      return { idx, name: parts[parts.length - 1] || ('file' + idx), path: [name, ...parts].join('/'), length: f.length }
    })
  } else {
    files = [{ idx: 0, name, path: name, length: info.length }]
  }
  return { infoHash, name, trackers, files }
}

/* ------------------------------------------------------------------- fetch */

async function fetchTorrentBuffer (url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'stremio-torrent-addon' } })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' while downloading .torrent')
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MAX_TORRENT_BYTES) throw new Error('.torrent file too large')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_TORRENT_BYTES) throw new Error('.torrent file too large')
    return buf
  } finally {
    clearTimeout(timer)
  }
}

async function fetchTorrent (url) {
  const t = parseTorrentFile(await fetchTorrentBuffer(url))
  t.torrentUrl = url
  return t
}

/* ------------------------------------------------------------- resolve any */

const cache = new Map() // source -> Promise<info>
const CACHE_MAX = 200

/**
 * Turn any user input (magnet link, hex/base32 info hash, or http(s) .torrent URL)
 * into { infoHash, name, trackers, files|null, kind }.
 */
async function resolveSource (input) {
  const source = String(input || '').trim()
  if (!source) throw new Error('Empty source')
  if (cache.has(source)) return cache.get(source)
  const p = (async () => {
    const hash = normalizeInfoHash(source)
    if (hash) return { kind: 'infohash', infoHash: hash, name: null, trackers: [], files: null }

    if (/^magnet:\?/i.test(source)) {
      const m = parseMagnet(source)
      const info = { kind: 'magnet', infoHash: m.infoHash, name: m.name, trackers: m.trackers, files: null }
      // Magnets may carry an "exact source" (xs=) pointing to the .torrent file -> use it for the file list.
      for (const xs of m.exactSources) {
        try {
          const t = await fetchTorrent(xs)
          if (t.infoHash === m.infoHash) {
            info.files = t.files
            info.torrentUrl = xs
            info.name = info.name || t.name
            t.trackers.forEach(tr => { if (!info.trackers.includes(tr)) info.trackers.push(tr) })
            break
          }
        } catch (e) { /* metadata is optional */ }
      }
      return info
    }

    if (/^https?:\/\//i.test(source)) {
      const t = await fetchTorrent(source)
      return { kind: 'torrent-url', ...t }
    }
    throw new Error('Unsupported input. Use a magnet link, a 40-char (hex) / 32-char (base32) info hash, or an http(s) link to a .torrent file.')
  })()
  cache.set(source, p)
  p.catch(() => cache.delete(source)) // don't cache failures
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return p
}

/** Stremio "sources" array: tracker:<url> entries + dht:<hash> */
function stremioSources (info) {
  const trackers = info.trackers && info.trackers.length ? info.trackers : DEFAULT_TRACKERS
  return [...trackers.map(t => 'tracker:' + t), 'dht:' + info.infoHash]
}

/** Video files sorted largest first (falls back to all files if none look like video). */
function playableFiles (files) {
  if (!files || !files.length) return []
  const vids = files.filter(f => VIDEO_EXT.test(f.name))
  return (vids.length ? vids : files).slice().sort((a, b) => b.length - a.length)
}

function formatBytes (n) {
  if (!Number.isFinite(n)) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return n.toFixed(i ? 2 : 0) + ' ' + u[i]
}

module.exports = {
  DEFAULT_TRACKERS,
  normalizeInfoHash,
  base32ToHex,
  parseMagnet,
  bdecode,
  parseTorrentFile,
  fetchTorrent,
  fetchTorrentBuffer,
  resolveSource,
  stremioSources,
  playableFiles,
  formatBytes
}
