#!/usr/bin/env node
// baton — command line entry point.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const config = require('../lib/config');
const args = process.argv.slice(2);
const cmd = (args[0] || 'help').toLowerCase();
const WIN = process.platform === 'win32';
const TASK = 'Baton';

const C = { b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
            y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m` };

function get(port, p, timeout = 3000) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout }, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, body: s }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 5000 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', () => resolve(null)); r.end();
  });
}
const running = async () => { const r = await get(config.get().port, '/api/health'); return !!(r && r.body && r.body.app === 'baton'); };
const token = () => { try { return JSON.parse(fs.readFileSync(path.join(config.MOBILE, 'secret.json'), 'utf8')).token; } catch { return null; } };
const appUrl = () => `http://127.0.0.1:${config.get().appPort}/?k=${encodeURIComponent(token() || '')}`;
function openBrowser(url) {
  if (WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}
const cdpUp = () => get(config.get().cdpPort, '/json/version', 1500).then(r => !!r);

const portClash = async () => !(await running()) && !!(await get(config.get().port, '/'));
const clashHelp = () => `Port ${config.get().port} is used by another program. Pick free ports: set "port" and "appPort" in ${config.SETTINGS_FILE}, then run "baton start".`;

async function startBackground() {
  if (await running()) { console.log(C.g('Baton is already running.')); return true; }
  if (await portClash()) { console.log(C.r(clashHelp())); return false; }
  const logFile = path.join(config.STATE, 'daemon-stdio.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: os.homedir() });
  child.unref();
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); if (await running()) { console.log(C.g('Baton started.')); return true; } }
  console.log(C.r('Baton did not answer within 10s. See ' + logFile));
  return false;
}

async function doctor() {
  const ok = (b, msg, fix) => console.log(`${b ? C.g('✔') : C.r('✘')} ${msg}${!b && fix ? C.d('\n    → ' + fix) : ''}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 18, `Node.js ${process.versions.node}`, 'Install Node.js 18 or newer.');
  let wsOk = true; try { require.resolve('ws'); } catch { wsOk = false; }
  ok(wsOk, 'dependencies installed', 'Run `npm install` in ' + ROOT);
  const claudeDir = path.join(config.APPDATA, 'Claude');
  ok(fs.existsSync(claudeDir), 'Claude Desktop data found', 'Install Claude Desktop and sign in: https://claude.ai/download');
  const cdp = await cdpUp();
  ok(cdp, `Claude Desktop debugger on port ${config.get().cdpPort}`, 'In Claude Desktop: Help > Troubleshooting > Enable Developer Mode, then Developer > Enable Main Process Debugger. Or run `baton debugger`.');
  const up = await running();
  ok(up, 'Baton daemon running', (await portClash()) ? clashHelp() : 'Run `baton start`.');
  let mcp = false;
  try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); mcp = !!(j.mcpServers && j.mcpServers.baton); } catch {}
  ok(mcp, 'MCP server registered with Claude Code (orchestrator tools)', 'Run `baton mcp install`.');
  const tunnel = require('../lib/tunnel');
  const mode = config.get().remote.mode;
  if (mode.startsWith('cloudflare')) ok(!!tunnel.binary(), 'cloudflared installed', WIN ? 'winget install Cloudflare.cloudflared' : 'brew install cloudflared');
  console.log(C.d(`\ndata: ${config.DATA}`));
}

async function pairCmd() {
  if (!(await running())) { console.log(C.y('Baton is not running — starting it…')); if (!(await startBackground())) return; }
  const r = await get(config.get().appPort, '/api/pair?k=' + encodeURIComponent(token() || ''), 8000);
  const links = (r && r.body && r.body.links) || [];
  if (!links.length) return console.log(C.r('Could not read pairing links.'));
  const pair = require('../lib/pair');
  const best = links[0];
  console.log(C.b(`\nScan with your phone camera (${best.label}):\n`));
  console.log(await pair.qrTerminal(best.url));
  for (const l of links) console.log(`  ${C.c(l.label.padEnd(22))} ${l.url}`);
  if (best.kind === 'local') console.log(C.y('\nOnly reachable from this computer. For your phone, choose Remote access in Settings (Cloudflare, Tailscale or Wi-Fi).'));
  console.log(C.d('\nThe link contains your access key. Treat it like a password.'));
}

function mcpInstall(remove) {
  const script = path.join(ROOT, 'mcp', 'baton-mcp.js');
  const argv = remove ? ['mcp', 'remove', '--scope', 'user', 'baton'] : ['mcp', 'add', '--scope', 'user', 'baton', '--', process.execPath, script];
  const r = spawnSync('claude', argv, { stdio: 'inherit', shell: WIN });
  if (r.status === 0) return console.log(C.g(remove ? 'Removed.' : 'Registered MCP server "baton". Restart Claude Desktop to load the tools.'));
  console.log(C.y('The `claude` CLI was not found or refused. Add this to ~/.claude.json under "mcpServers" instead:'));
  console.log(JSON.stringify({ baton: { type: 'stdio', command: process.execPath, args: [script] } }, null, 2));
}

function autostart(action) {
  if (!WIN) {
    console.log('Autostart is automated on Windows only. On macOS/Linux, add `' + process.execPath + ' ' + path.join(ROOT, 'server.js') + '` to your login items (launchd / systemd --user).');
    return;
  }
  if (action === 'remove') {
    spawnSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { stdio: 'inherit' });
    return;
  }
  const vbs = path.join(ROOT, 'scripts', 'run-hidden.vbs');
  const tray = path.join(ROOT, 'scripts', 'tray.ps1');
  const tr = `wscript.exe "${vbs}" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${tray}"`;
  const r = spawnSync('schtasks', ['/Create', '/TN', TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', tr], { stdio: 'inherit' });
  if (r.status === 0) console.log(C.g('Baton (with its tray icon) will start when you sign in. Start it now with `baton tray`.'));
}

function tray() {
  if (!WIN) return console.log('The tray icon is Windows-only for now. Use `baton open`.');
  const ps = path.join(ROOT, 'scripts', 'tray.ps1');
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log(C.g('Tray icon started (look for the baton in the notification area).'));
}

async function setup() {
  console.log(C.b('\nBaton setup\n'));
  await doctor();
  if (!(await cdpUp()) && WIN) {
    console.log(C.y('\nTrying to switch on the Claude Desktop debugger for you (Claude will come to the front briefly)…'));
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'enable-debugger.ps1')], { stdio: 'inherit' });
  }
  let mcp = false;
  try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); mcp = !!(j.mcpServers && j.mcpServers.baton); } catch {}
  if (!mcp) mcpInstall(false);
  if (WIN) autostart('install');
  await startBackground();
  if (WIN) tray();
  console.log(C.b('\nDone. Opening Baton — use Settings › Pair a phone to connect your phone.'));
  openBrowser(appUrl());
}

function help() {
  console.log(`${C.b('baton')} — your Claude Code sessions, in your pocket

${C.b('Everyday')}
  baton setup              one-time setup: checks, MCP tools, autostart, opens the app
  baton open               open the app on this computer
  baton pair               show the QR code / link that signs your phone in
  baton status             is everything working? (alias: doctor)

${C.b('Daemon')}
  baton start              start in the background     (baton start --foreground to debug)
  baton stop | restart
  baton tray               Windows tray icon (open, pair, settings, restart, quit)
  baton autostart [remove] start with Windows (tray + daemon)
  baton debugger           switch on Claude Desktop's main-process debugger (Windows)
  baton mcp install|remove register the orchestrator tools with Claude Code

${C.b('Remote access')}   (also in Settings › Remote access)
  baton tunnel quick                random https://….trycloudflare.com address, no account
  baton tunnel login                authorise this computer with your Cloudflare account
  baton tunnel setup <hostname>     fixed address, e.g. baton.example.com
  baton tunnel off | status

${C.b('Orchestrator')}
  baton run <task> · preview <task> · ls · show <id> · stop <id> · escalate <id>
  baton sessions · archivable · health · prune [days]

${C.d('data: ' + config.DATA)}`);
}

(async () => {
  switch (cmd) {
    case 'help': case '-h': case '--help': return help();
    case '--version': case 'version': return console.log(require('../package.json').version);
    case 'start':
      if (args.includes('--foreground') || args.includes('-f')) return require('../server.js');
      return void (await startBackground());
    case 'stop': {
      const s = await post(config.get().port, '/api/shutdown');
      return console.log(s ? C.g('Stopping…') : C.y('Baton was not running.'));
    }
    case 'restart':
      await post(config.get().port, '/api/shutdown');
      for (let i = 0; i < 60 && await running(); i++) await new Promise(r => setTimeout(r, 250));
      return void (await startBackground());
    case 'open':
      if (!(await running())) await startBackground();
      return openBrowser(appUrl());
    case 'pair': return pairCmd();
    case 'status': case 'doctor': return doctor();
    case 'setup': return setup();
    case 'tray': return tray();
    case 'autostart': return autostart(args[1]);
    case 'debugger':
      if (!WIN) return console.log('In Claude Desktop: Developer > Enable Main Process Debugger.');
      return void spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'enable-debugger.ps1')], { stdio: 'inherit' });
    case 'mcp': return mcpInstall(args[1] === 'remove');
    case 'tunnel': {
      const tunnel = require('../lib/tunnel');
      const sub = (args[1] || 'status').toLowerCase();
      if (sub === 'quick') { config.set({ remote: { mode: 'cloudflare-quick' } }); console.log('Remote access: Cloudflare quick tunnel. Restart Baton (`baton restart`), then `baton pair`.'); return; }
      if (sub === 'off') { config.set({ remote: { mode: 'off' } }); return console.log('Remote access off. `baton restart` to apply.'); }
      if (sub === 'login') { const r = await tunnel.login(); if (r.loginUrl) { console.log('Opening: ' + r.loginUrl); openBrowser(r.loginUrl); } else console.log(r); return; }
      if (sub === 'setup') { const r = await tunnel.setupNamed(args[2], args[3]); tunnel.stop(); console.log(r.ok ? C.g(`Ready: https://${r.hostname} — run \`baton restart\`, then \`baton pair\`.`) : C.r(r.error + (r.detail ? '\n' + r.detail : ''))); return; }
      const st = await get(config.get().appPort, '/api/tunnel?k=' + encodeURIComponent(token() || ''));
      return console.log(JSON.stringify((st && st.body && st.body.tunnel) || tunnel.status(), null, 2));
    }
    default:
      process.argv = [process.argv[0], path.join(ROOT, 'cli.js'), ...args];
      return require('../cli.js');
  }
})().catch(e => { console.error(C.r('error: ' + e.message)); process.exit(1); });
