'use strict'
const safeJson = obj => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

module.exports = function configurePage (manifest, current) {
  const cfg = current || { addons: [], magnets: [], keepTorrent: false }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${manifest.name} – configure</title>
<style>
 body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#141225;color:#eee;max-width:760px;margin:0 auto;padding:24px}
 h1{margin:0 0 4px} p.small{color:#aaa;font-size:14px;margin-top:0}
 label{display:block;font-weight:600;margin:18px 0 6px}
 textarea,input[type=text]{width:100%;box-sizing:border-box;background:#211e3a;color:#fff;border:1px solid #4b4580;border-radius:8px;padding:10px;font-family:monospace;font-size:13px}
 textarea{min-height:110px}
 .hint{color:#9a96c8;font-size:13px;margin-top:4px}
 button,a.btn{display:inline-block;background:#7b5bf5;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-size:15px;cursor:pointer;text-decoration:none;margin:8px 8px 0 0}
 a.btn.alt,button.alt{background:#35305e}
 #out{display:none;margin-top:22px;padding:16px;border-radius:10px;background:#1c1933;border:1px solid #4b4580}
 .err{color:#ff8080}
</style></head><body>
<h1>⚡ ${manifest.name}</h1>
<p class="small">v${manifest.version} — ${manifest.description}</p>

<label for="addons">1. Your torrent add-ons (manifest URLs, one per line)</label>
<textarea id="addons" placeholder="https://example-addon.com/manifest.json"></textarea>
<div class="hint">In Stremio: Add-ons → your add-on → "Share"/copy link. stremio:// links work too.</div>

<label for="magnets">2. (Optional) Your own magnet links / info hashes / .torrent URLs, one per line</label>
<textarea id="magnets" placeholder="magnet:?xt=urn:btih:..."></textarea>
<div class="hint">They appear in Discover → Movies → "Migeloforreal".</div>

<label><input type="checkbox" id="keep"> Also show the original torrent streams (next to the HTTP ones)</label>

<button id="go">Generate install link</button>
<div id="out">
  <div><b>Your add-on URL:</b></div>
  <input type="text" id="url" readonly>
  <div>
    <a class="btn" id="install" href="#">Install in Stremio</a>
    <a class="btn alt" id="web" href="#" target="_blank" rel="noopener">Install in Stremio Web</a>
    <button class="alt" id="copy" type="button">Copy URL</button>
  </div>
  <div class="hint">On phone / TV: copy the URL, then in Stremio go to Add-ons → search box → paste it.</div>
</div>
<p id="error" class="err"></p>

<script>
const current = ${safeJson(cfg)};
const $ = id => document.getElementById(id);
$('addons').value = (current.addons || []).join('\\n');
$('magnets').value = (current.magnets || []).join('\\n');
$('keep').checked = !!current.keepTorrent;
function b64url (str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
const lines = v => v.split(/[\\r\\n]+/).map(s => s.trim()).filter(Boolean);
$('go').onclick = () => {
  $('error').textContent = '';
  const cfg = { addons: lines($('addons').value), magnets: lines($('magnets').value), keepTorrent: $('keep').checked };
  if (!cfg.addons.length && !cfg.magnets.length) { $('error').textContent = 'Add at least one add-on URL or one magnet.'; return; }
  const url = location.origin + '/' + b64url(JSON.stringify(cfg)) + '/manifest.json';
  $('url').value = url;
  $('install').href = url.replace(/^https?:\\/\\//, 'stremio://');
  $('web').href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(url);
  $('out').style.display = 'block';
};
$('copy').onclick = () => { $('url').select(); (navigator.clipboard ? navigator.clipboard.writeText($('url').value) : Promise.resolve(document.execCommand('copy'))); $('copy').textContent = 'Copied ✓'; };
</script>
</body></html>`
}
