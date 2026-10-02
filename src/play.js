'use strict'
/** GET/HEAD /play/:infoHash/:fileIdx/:name  ->  the torrent file over plain HTTP, with Range (206) support */
const crypto = require('crypto')
const path = require('path')
const rangeParser = require('range-parser')
const engine = require('./engine')
const { normalizeInfoHash } = require('./torrent')
const { signPlay, PLAY_SECRET } = require('./addon')

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ogv': 'video/ogg',
  '.3gp': 'video/3gpp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.ass': 'text/x-ssa', '.jpg': 'image/jpeg', '.png': 'image/png'
}
const mimeOf = name => MIME[path.extname(name || '').toLowerCase()] || 'application/octet-stream'

function safeEqual (a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

async function playHandler (req, res) {
  const infoHash = normalizeInfoHash(req.params.infoHash)
  const fileIdx = req.params.fileIdx
  if (!infoHash || !/^(auto|\d+)$/.test(fileIdx)) return res.status(400).json({ err: 'bad infoHash or fileIdx' })
  if (PLAY_SECRET && !safeEqual(req.query.sig || '', signPlay(infoHash, fileIdx))) return res.status(403).json({ err: 'bad signature' })

  let torrent, file
  try {
    torrent = await engine.getTorrent(infoHash)
    file = engine.pickFile(torrent, fileIdx)
  } catch (err) {
    return res.status(err.status || 504).json({ err: err.message })
  }

  const size = file.length
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', mimeOf(file.name))
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
  res.setHeader('Cache-Control', 'no-store')

  let start = 0
  let end = size - 1
  const ranges = req.headers.range ? rangeParser(size, req.headers.range, { combine: true }) : null
  if (ranges === -1) { // unsatisfiable
    res.setHeader('Content-Range', `bytes */${size}`)
    return res.status(416).end()
  }
  if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length) {
    start = ranges[0].start; end = ranges[0].end // multi-range: only the first range is served
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  } else {
    res.status(200)
  }
  const length = end - start + 1
  res.setHeader('Content-Length', length)
  if (req.method === 'HEAD' || length <= 0) return res.end()

  engine.markActive(infoHash, +1)
  let closed = false
  // WebTorrent treats end=0 as "until end of file", so ask for 2 bytes and cap the output ourselves
  const it = file[Symbol.asyncIterator]({ start, end: end === 0 ? Math.min(1, size - 1) : end })
  res.on('close', () => { closed = true; Promise.resolve(it.return && it.return()).catch(() => {}) })
  let sent = 0
  try {
    while (!closed && sent < length) {
      const { value, done } = await it.next()
      if (done || closed) break
      const left = length - sent
      const chunk = value.length > left ? value.subarray(0, left) : value // WebTorrent ignores end=0, so cap ourselves
      sent += chunk.length
      if (!res.write(chunk)) {
        await new Promise(resolve => {
          const go = () => { res.off('drain', go); res.off('close', go); resolve() }
          res.on('drain', go); res.on('close', go)
        })
      }
    }
    if (!closed) {
      if (sent === length) res.end()
      else res.destroy() // torrent was removed / file destroyed mid-way
    }
  } catch (err) {
    console.warn('[play] stream error:', err.message)
    res.destroy()
  } finally {
    if (sent >= length) Promise.resolve(it.return && it.return()).catch(() => {})
    engine.markActive(infoHash, -1)
  }
}

module.exports = { playHandler, mimeOf }
