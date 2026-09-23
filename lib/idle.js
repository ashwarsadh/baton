'use strict';

const { spawn } = require('child_process');

const SAMPLE_MS = 400;
const STALE_MS = 2000;
const RESTART_BACKOFF_MS = 5000;

let proc = null;
let lastIdleMs = null;
let lastAt = 0;
let lastSpawnAt = 0;
let starting = false;

const PS = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
public class AgoIdle {
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  public static uint Ms() {
    LASTINPUTINFO l = new LASTINPUTINFO();
    l.cbSize = (uint)Marshal.SizeOf(l);
    GetLastInputInfo(ref l);
    return GetTickCount() - l.dwTime;
  }
}
"@
while ($true) { [Console]::Out.WriteLine([AgoIdle]::Ms()); Start-Sleep -Milliseconds ${SAMPLE_MS} }
`;

function start() {
  if (proc || starting) return;
  if (Date.now() - lastSpawnAt < RESTART_BACKOFF_MS) return;
  starting = true;
  lastSpawnAt = Date.now();
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    proc.stdout.setEncoding('utf8');
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const n = Number(line);
        if (Number.isFinite(n) && n >= 0) { lastIdleMs = n; lastAt = Date.now(); }
      }
    });
    const gone = () => { proc = null; lastIdleMs = null; };
    proc.on('exit', gone);
    proc.on('error', gone);
    if (proc.unref) proc.unref();
  } catch { proc = null; }
  starting = false;
}

function idleMs() {
  start();
  if (lastIdleMs === null) return null;
  const age = Date.now() - lastAt;
  if (age > STALE_MS) return null;
  return lastIdleMs + age;
}

function isIdle(minMs) {
  if (!(minMs > 0)) return true;
  if (process.platform !== 'win32') return true; // no idle probe outside Windows yet
  const ms = idleMs();
  return ms !== null && ms >= minMs;
}

function stop() { try { if (proc) proc.kill(); } catch {} proc = null; lastIdleMs = null; }

module.exports = { idleMs, isIdle, start, stop, SAMPLE_MS };
