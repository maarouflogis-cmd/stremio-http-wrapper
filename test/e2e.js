'use strict'
/**
 * End-to-end check (needs internet + BitTorrent access):
 *   npm test
 * Starts the mock upstream add-on (legal Blender movies) and two wrapper instances, then checks
 * manifest, configure page, stream wrapping, HTTP pass-through, /play Range requests, direct magnets,
 * signed play links and idle cleanup.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { encodeConfig } = require('../src/config')

const ROOT = path.join(__dirname, '..')
const SINTEL = '08ada5a7a6183aae1e09d831df6748d566095a10'
const SINTEL_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=wss%3A%2F%2Ftracker.webtorrent.dev&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent'
const procs = []
let failures = 0

function start (script, env) {
  const p = spawn(process.execPath, [script], { cwd: ROOT, env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('   [' + path.basename(script) + ':' + (env.PORT || env.MOCK_PORT) + '] ' + d))
  p.stderr.on('data', d => process.stdout.write('   [stderr ' + path.basename(script) + '] ' + d))
  procs.push(p)
  return p
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor (url) {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url)).ok) return } catch (_) {} await sleep(200) }
  throw new Error('server did not start: ' + url)
}
async function check (name, fn) {
  try { const info = await fn(); console.log('PASS', name, info ? '→ ' + info : '') } catch (err) { failures++; console.log('FAIL', name, '→', err.message) }
}
async function getBytes (url, range) {
  const t = Date.now()
  const res = await fetch(url, { headers: range ? { range } : {} })
  const buf = Buffer.from(await res.arrayBuffer())
  return { res, buf, ms: Date.now() - t }
}

;(async () => {
  const cache1 = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-a-'))
  const cache2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-b-'))
  start('test/mock-upstream.js', { MOCK_PORT: '7101' })
  start('server.js', { PORT: '7100', CACHE_DIR: cache1, PLAY_SECRET: '' })
  start('server.js', { PORT: '7102', CACHE_DIR: cache2, PLAY_SECRET: 'test-secret', IDLE_TIMEOUT_MIN: '0.05', CLEANUP_INTERVAL_SEC: '2' })
  await Promise.all(['http://127.0.0.1:7101/manifest.json', 'http://127.0.0.1:7100/health', 'http://127.0.0.1:7102/health'].map(waitFor))

  const B = 'http://127.0.0.1:7100'
  const CFG = encodeConfig({ addons: ['http://127.0.0.1:7101/manifest.json'], magnets: [SINTEL_MAGNET] })
  let streams

  await check('base manifest.json is valid JSON and asks for configuration', async () => {
    const m = await (await fetch(B + '/manifest.json')).json()
    assert.strictEqual(m.id, 'org.omar.stremio-http-wrapper')
    assert.strictEqual(m.behaviorHints.configurationRequired, true)
    return `${m.name} v${m.version}, resources=${JSON.stringify(m.resources.map(r => r.name || r))}`
  })
  await check('configured manifest is installable', async () => {
    const m = await (await fetch(`${B}/${CFG}/manifest.json`)).json()
    assert.ok(!m.behaviorHints.configurationRequired)
    return `catalogs=${m.catalogs.map(c => c.name)}`
  })
  await check('configure page served', async () => {
    const r = await fetch(B + '/configure'); const html = await r.text()
    assert.strictEqual(r.status, 200); assert.ok(html.includes('Generate install link'))
    return `${html.length} bytes of HTML`
  })
  await check('stream wrapping: torrent streams -> http /play URLs, http stream passes through', async () => {
    const data = await (await fetch(`${B}/${CFG}/stream/movie/tt1727587.json`)).json()
    streams = data.streams
    console.log('   response:', JSON.stringify(data))
    assert.strictEqual(streams.length, 3)
    assert.ok(streams[0].url.startsWith(`${B}/play/${SINTEL}/5/`)); assert.ok(!streams[0].infoHash)
    assert.ok(streams[1].url.startsWith(`${B}/play/${SINTEL}/auto/`))
    assert.strictEqual(streams[2].url, 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4')
    return streams.map(s => s.url).join(' | ')
  })
  await check('HEAD /play -> size + content-type', async () => {
    const r = await fetch(streams[0].url, { method: 'HEAD' })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.headers.get('content-type'), 'video/mp4')
    return `status=${r.status} content-length=${r.headers.get('content-length')} type=${r.headers.get('content-type')} accept-ranges=${r.headers.get('accept-ranges')}`
  })
  await check('Range bytes=0-1048575 -> 206 with real MP4 bytes', async () => {
    const { res, buf, ms } = await getBytes(streams[0].url, 'bytes=0-1048575')
    assert.strictEqual(res.status, 206); assert.strictEqual(buf.length, 1048576)
    assert.strictEqual(buf.toString('ascii', 4, 8), 'ftyp')
    return `status=${res.status} content-range="${res.headers.get('content-range')}" got ${buf.length} bytes in ${ms} ms, box type="${buf.toString('ascii', 4, 8)}"`
  })
  await check('seek: Range in the middle of the file -> 206', async () => {
    const { res, buf, ms } = await getBytes(streams[0].url, 'bytes=100000000-100065535')
    assert.strictEqual(res.status, 206); assert.strictEqual(buf.length, 65536)
    return `content-range="${res.headers.get('content-range')}" ${buf.length} bytes in ${ms} ms`
  })
  await check('Range bytes=0-0 -> exactly 1 byte', async () => {
    const { res, buf } = await getBytes(streams[0].url, 'bytes=0-0')
    assert.strictEqual(res.status, 206); assert.strictEqual(buf.length, 1)
    return `content-range="${res.headers.get('content-range')}"`
  })
  await check('unsatisfiable range -> 416', async () => {
    const { res } = await getBytes(streams[0].url, 'bytes=999999999999-')
    assert.strictEqual(res.status, 416)
    return `status=${res.status} content-range="${res.headers.get('content-range')}"`
  })
  await check('magnet-url stream ("auto" = largest video) -> 206', async () => {
    const { res, buf } = await getBytes(streams[1].url, 'bytes=0-65535')
    assert.strictEqual(res.status, 206); assert.strictEqual(buf.length, 65536)
    return `content-range="${res.headers.get('content-range')}"`
  })
  await check('Big Buck Bunny (infoHash only, peers only) -> 206', async () => {
    const data = await (await fetch(`${B}/${CFG}/stream/movie/tt1254207.json`)).json()
    const { res, buf, ms } = await getBytes(data.streams[0].url, 'bytes=0-262143')
    assert.strictEqual(res.status, 206); assert.strictEqual(buf.length, 262144)
    return `${data.streams[0].url} → content-range="${res.headers.get('content-range')}" in ${ms} ms`
  })
  let directId
  await check('direct magnet: catalog "My torrents" lists it', async () => {
    const data = await (await fetch(`${B}/${CFG}/catalog/movie/wrapper-my-torrents.json`)).json()
    assert.strictEqual(data.metas.length, 1); assert.strictEqual(data.metas[0].name, 'Sintel')
    directId = data.metas[0].id
    return JSON.stringify(data.metas[0]).slice(0, 220) + '…'
  })
  await check('direct magnet: meta + stream (one per video file, with fileIdx)', async () => {
    const meta = await (await fetch(`${B}/${CFG}/meta/movie/${encodeURIComponent(directId)}.json`)).json()
    assert.strictEqual(meta.meta.name, 'Sintel')
    const data = await (await fetch(`${B}/${CFG}/stream/movie/${encodeURIComponent(directId)}.json`)).json()
    assert.ok(data.streams[0].url.includes(`/play/${SINTEL}/5/Sintel.mp4`))
    return JSON.stringify(data.streams)
  })
  await check('loop protection (request coming from another wrapper) -> no streams', async () => {
    const data = await (await fetch(`${B}/${CFG}/stream/movie/tt1727587.json`, { headers: { 'x-stremio-http-wrapper': '1' } })).json()
    assert.strictEqual(data.streams.length, 0)
  })
  await check('/stats shows the running torrents', async () => {
    const s = await (await fetch(B + '/stats')).json()
    return s.torrents.map(t => `${t.name}: ready=${t.ready} peers=${t.peers} downloaded=${(t.downloaded / 1048576).toFixed(1)}MB`).join('; ')
  })

  // ---- second instance: PLAY_SECRET + fast idle cleanup
  const B2 = 'http://127.0.0.1:7102'
  await check('PLAY_SECRET: unsigned /play -> 403, signed link from stream response -> 206', async () => {
    const unsigned = await fetch(`${B2}/play/${SINTEL}/5/Sintel.mp4`, { headers: { range: 'bytes=0-9' } })
    assert.strictEqual(unsigned.status, 403)
    const data = await (await fetch(`${B2}/${CFG}/stream/movie/tt1727587.json`)).json()
    assert.ok(data.streams[0].url.includes('?sig='))
    const { res, buf } = await getBytes(data.streams[0].url, 'bytes=0-9')
    assert.strictEqual(res.status, 206); assert.strictEqual(buf.length, 10)
    return `unsigned=${unsigned.status}, signed=${res.status} (${data.streams[0].url})`
  })
  await check('idle cleanup removes the torrent and its cache folder', async () => {
    const before = fs.readdirSync(cache2)
    await sleep(9000)
    const s = await (await fetch(`${B2}/stats?key=test-secret`)).json()
    const after = fs.readdirSync(cache2)
    assert.strictEqual(s.torrents.length, 0); assert.ok(!after.includes(SINTEL))
    return `cache before=${JSON.stringify(before)} after=${JSON.stringify(after)}, torrents now=${s.torrents.length}`
  })

  procs.forEach(p => p.kill('SIGTERM'))
  await sleep(1500)
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED')
  process.exit(failures ? 1 : 0)
})().catch(err => { console.error(err); procs.forEach(p => p.kill()); process.exit(1) })
