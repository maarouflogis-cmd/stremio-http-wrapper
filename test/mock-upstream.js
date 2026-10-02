'use strict'
/**
 * Tiny fake "torrent add-on" used for local testing. It only returns LEGAL, freely licensed
 * Blender open movies (Sintel, Big Buck Bunny) from the WebTorrent demo torrents.
 *   node test/mock-upstream.js   ->  http://127.0.0.1:7001/manifest.json
 */
const express = require('express')
const PORT = Number(process.env.MOCK_PORT || 7001)

const SINTEL = '08ada5a7a6183aae1e09d831df6748d566095a10'
const BBB = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'
const TRACKERS = ['udp://explodie.org:6969', 'udp://tracker.opentrackr.org:1337/announce', 'wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com']

const app = express()
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next() })
app.get('/manifest.json', (_, res) => res.json({
  id: 'test.mock.upstream', version: '1.0.0', name: 'Mock Torrent Upstream',
  description: 'Returns the Sintel / Big Buck Bunny WebTorrent demo torrents (CC-BY Blender Foundation).',
  resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: []
}))
app.get('/stream/:type/:id.json', (req, res) => {
  const { id } = req.params
  if (id === 'tt1727587') { // Sintel (2010)
    return res.json({ streams: [
      { name: 'Mock\n1080p', title: 'Sintel (infoHash + fileIdx)', infoHash: SINTEL, fileIdx: 5, sources: TRACKERS.map(t => 'tracker:' + t).concat('dht:' + SINTEL), behaviorHints: { filename: 'Sintel.mp4', bingeGroup: 'mock-sintel' } },
      { name: 'Mock\nmagnet', title: 'Sintel (magnet url)', url: 'magnet:?xt=urn:btih:' + SINTEL + '&dn=Sintel&tr=' + encodeURIComponent(TRACKERS[0]) + '&xs=' + encodeURIComponent('https://webtorrent.io/torrents/sintel.torrent') },
      { name: 'Mock\nHTTP', title: 'Already-HTTP stream (should pass through)', url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4' }
    ] })
  }
  if (id === 'tt1254207') { // Big Buck Bunny (2008)
    return res.json({ streams: [{ name: 'Mock', title: 'Big Buck Bunny', infoHash: BBB, sources: TRACKERS.map(t => 'tracker:' + t) }] })
  }
  res.json({ streams: [] })
})
app.listen(PORT, () => console.log(`Mock upstream add-on: http://127.0.0.1:${PORT}/manifest.json`))
