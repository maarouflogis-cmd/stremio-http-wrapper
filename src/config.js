'use strict'
/**
 * User configuration lives in the add-on URL itself (no database):
 *   https://your-server/<CONFIG>/manifest.json
 * <CONFIG> = base64url( JSON.stringify({ addons: [...manifest urls], magnets: [...], keepTorrent: bool }) )
 * base64url keeps the path free of "/", "%" and "?" characters, so it survives proxies and CDNs.
 * The SDK-style form (URL-encoded JSON) is accepted too.
 */

function splitLines (v) {
  if (Array.isArray(v)) v = v.join('\n')
  return String(v || '')
    .split(/[\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

function normalizeAddonUrl (u) {
  let url = u.trim().replace(/^stremio:\/\//i, 'https://')
  if (!/^https?:\/\//i.test(url)) return null
  url = url.replace(/\/+$/, '')
  if (!/\/manifest\.json$/i.test(url)) url += '/manifest.json'
  return url
}

function normalizeConfig (raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const addons = [...new Set(splitLines(cfg.addons).map(normalizeAddonUrl).filter(Boolean))]
  const magnets = [...new Set(splitLines(cfg.magnets))]
  return { addons, magnets, keepTorrent: cfg.keepTorrent === true || cfg.keepTorrent === 'true' || cfg.keepTorrent === 'on' }
}

function encodeConfig (cfg) {
  return Buffer.from(JSON.stringify(normalizeConfig(cfg)), 'utf8').toString('base64url')
}

function decodeConfig (segment) {
  if (!segment) return null
  // 1) base64url JSON (what our configure page produces)
  if (/^[A-Za-z0-9_-]+$/.test(segment)) {
    try {
      const obj = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
      if (obj && typeof obj === 'object') return normalizeConfig(obj)
    } catch (_) {}
  }
  // 2) URL-encoded JSON (stremio-addon-sdk default style)
  try {
    const obj = JSON.parse(decodeURIComponent(segment))
    if (obj && typeof obj === 'object') return normalizeConfig(obj)
  } catch (_) {}
  return null
}

module.exports = { encodeConfig, decodeConfig, normalizeConfig, normalizeAddonUrl, splitLines }
