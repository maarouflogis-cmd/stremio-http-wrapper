#!/usr/bin/env node
'use strict'
const express = require('express')
const cors = require('cors')
const qs = require('querystring')
const { addonInterface, manifest, PLAY_SECRET, LOOP_HEADER } = require('./src/addon')
const { decodeConfig } = require('./src/config')
const { playHandler } = require('./src/play')
const configurePage = require('./src/configurePage')
const engine = require('./src/engine')

const PORT = Number(process.env.PORT || 7000)
const HOST = process.env.HOST || '0.0.0.0'
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (process.env.SPACE_HOST ? 'https://' + process.env.SPACE_HOST : '')).replace(/\/+$/, '')

const app = express()
app.set('trust proxy', true)
app.use(cors())

/** Public base URL of this server (used to build /play links). */
function baseUrl (req) {
  if (PUBLIC_URL) return PUBLIC_URL
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim()
  return `${proto}://${host}`
}

/* ------------------------------------------------------------ pages */
app.get('/', (_req, res) => res.redirect('/configure'))
app.get('/configure', (_req, res) => res.type('html').send(configurePage(manifest, null)))
app.get('/health', (_req, res) => res.json({ ok: true, version: manifest.version }))
app.get('/stats', (req, res) => {
  if (PLAY_SECRET && req.query.key !== PLAY_SECRET) return res.status(403).json({ err: 'forbidden' })
  res.json(engine.stats())
})

/* ------------------------------------------------------------ play */
app.get('/play/:infoHash/:fileIdx/:name?', playHandler)
app.head('/play/:infoHash/:fileIdx/:name?', playHandler)

/* ------------------------------------------------------------ add-on protocol */
function manifestFor (cfg) {
  const m = JSON.parse(JSON.stringify(manifest))
  if (cfg) {
    delete m.behaviorHints.configurationRequired // installable once configured
    if (!cfg.magnets.length) m.catalogs = [] // no "My torrents" row if there are no magnets
  }
  return m
}

app.get('/manifest.json', (_req, res) => res.json(manifestFor(null)))
app.get('/:config/manifest.json', (req, res) => {
  const cfg = decodeConfig(req.params.config)
  if (!cfg) return res.status(400).json({ err: 'invalid config in URL' })
  res.json(manifestFor(cfg))
})
app.get('/:config/configure', (req, res) => res.type('html').send(configurePage(manifest, decodeConfig(req.params.config))))

async function resourceHandler (req, res) {
  const { resource, type, id } = req.params
  const cfg = req.params.config ? decodeConfig(req.params.config) : { addons: [], magnets: [], keepTorrent: false }
  if (!cfg) return res.status(400).json({ err: 'invalid config in URL' })
  // the SDK way: parse "extra" from the raw URL so encoded "&" inside values survive
  const last = req.path.split('/').pop()
  const extra = req.params.extra ? qs.parse(last.slice(0, -5)) : {}
  const config = Object.assign({}, cfg, { _base: baseUrl(req), _loop: !!req.headers[LOOP_HEADER] })
  try {
    const resp = await addonInterface.get(resource, type, id, extra, config)
    res.setHeader('Cache-Control', Number.isInteger(resp.cacheMaxAge) ? `max-age=${resp.cacheMaxAge}, public` : 'no-cache')
    delete resp.cacheMaxAge
    res.json(resp)
  } catch (err) {
    if (err && err.noHandler) return res.status(404).json({ err: 'not found' })
    console.error(err)
    res.status(500).json({ err: 'handler error' })
  }
}
const R = ':resource(catalog|meta|stream)/:type/:id/:extra?.json'
app.get('/' + R, resourceHandler)
app.get('/:config/' + R, resourceHandler)

/* ------------------------------------------------------------ start */
engine.cleanCacheDirOnStart()
const server = app.listen(PORT, HOST, () => {
  console.log(`HTTP wrapper add-on running: http://127.0.0.1:${PORT}/manifest.json`)
  console.log(`Configure page:              http://127.0.0.1:${PORT}/configure`)
  console.log(`Torrent cache dir:           ${engine.CACHE_DIR}`)
  if (!PLAY_SECRET) console.log('Tip: set PLAY_SECRET=<random string> on public servers so only your own links can use /play.')
})

let stopping = false
function stop () {
  if (stopping) return; stopping = true
  console.log('Shutting down, cleaning torrent cache…')
  server.close()
  engine.shutdown().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('uncaughtException', err => console.error('[uncaught]', err && err.stack || err)) // keep serving other users
process.on('unhandledRejection', err => console.error('[unhandled]', err && err.stack || err))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
module.exports = { app }
