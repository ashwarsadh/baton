// pair.js — the links (and QR codes) that open the app on a phone, already signed in.
'use strict';
const os = require('os');
const config = require('./config');
const tunnel = require('./tunnel');

function interfaces() {
  const out = { tailscale: [], lan: [] };
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const o = a.address.split('.').map(Number);
      if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) out.tailscale.push({ name, address: a.address });
      else if (o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)) out.lan.push({ name, address: a.address });
    }
  }
  return out;
}

/** Every address the app answers on right now, best first, each with a sign-in link. */
function links(token) {
  const cfg = config.get();
  const port = cfg.appPort;
  const k = token ? '/?k=' + encodeURIComponent(token) : '/';
  const list = [];
  const pub = tunnel.publicUrl();
  if (pub) list.push({ kind: 'public', label: 'Anywhere (Cloudflare)', url: pub + k });
  const nics = interfaces();
  for (const t of nics.tailscale) list.push({ kind: 'tailscale', label: 'Tailscale', url: `http://${t.address}:${port}${k}` });
  if ((cfg.remote || {}).mode === 'lan') for (const l of nics.lan) list.push({ kind: 'lan', label: 'Same Wi-Fi', url: `http://${l.address}:${port}${k}` });
  list.push({ kind: 'local', label: 'This computer', url: `http://127.0.0.1:${port}${k}` });
  return list;
}

async function qrSvg(text) {
  try {
    const QR = require('qrcode');
    return await QR.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  } catch { return null; }
}

async function qrTerminal(text) {
  try { return await require('qrcode').toString(text, { type: 'terminal', small: true }); } catch { return ''; }
}

module.exports = { links, interfaces, qrSvg, qrTerminal };
