'use strict';

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

// ---- System CPU sampling (instantaneous %) --------------------------------
let lastCpu = cpuTotals();

function cpuTotals() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

function systemCpuPercent() {
  const now = cpuTotals();
  const idleDiff = now.idle - lastCpu.idle;
  const totalDiff = now.total - lastCpu.total;
  lastCpu = now;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 1000) / 10));
}

// ---- Per-process CPU sampling (Linux /proc, instantaneous %) ---------------
const procSamples = new Map(); // pid -> { ticks, time }

function processStats(pid) {
  if (!pid) return { cpu: 0, memMB: 0 };
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the (comm) may contain spaces; split on the last ')'.
    const rParen = stat.lastIndexOf(')');
    const fields = stat.slice(rParen + 2).split(' ');
    // utime=14th, stime=15th overall -> here indices 11 & 12 (0-based after comm)
    const utime = parseInt(fields[11], 10) || 0;
    const stime = parseInt(fields[12], 10) || 0;
    const ticks = utime + stime;
    const now = Date.now();
    const clkTck = 100; // USER_HZ on virtually all Linux
    const prev = procSamples.get(pid);
    procSamples.set(pid, { ticks, time: now });

    let cpu = 0;
    if (prev) {
      const dt = (now - prev.time) / 1000;
      if (dt > 0) {
        const cpuSecs = (ticks - prev.ticks) / clkTck;
        cpu = Math.round((cpuSecs / dt) * 1000) / 10; // % of one core
      }
    }

    let memMB = 0;
    try {
      const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
      const rssPages = parseInt(statm[1], 10) || 0;
      memMB = Math.round((rssPages * 4096) / (1024 * 1024));
    } catch (_) {}
    return { cpu: Math.max(0, cpu), memMB };
  } catch (_) {
    return { cpu: 0, memMB: 0 };
  }
}

// ---- Disk usage (df) -------------------------------------------------------
function diskUsage(targetPath) {
  return new Promise((resolve) => {
    execFile('df', ['-kP', targetPath], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) return resolve(null);
      const parts = lines[lines.length - 1].split(/\s+/);
      // Filesystem 1024-blocks Used Available Capacity Mounted
      const totalKB = parseInt(parts[1], 10) || 0;
      const usedKB = parseInt(parts[2], 10) || 0;
      const availKB = parseInt(parts[3], 10) || 0;
      resolve({
        totalMB: Math.round(totalKB / 1024),
        usedMB: Math.round(usedKB / 1024),
        availMB: Math.round(availKB / 1024),
        percent: totalKB ? Math.round((usedKB / totalKB) * 100) : 0,
      });
    });
  });
}

function javaVersion() {
  return new Promise((resolve) => {
    execFile('java', ['-version'], { timeout: 5000 }, (err, _stdout, stderr) => {
      if (err) return resolve(null);
      const first = (stderr || '').split('\n')[0] || '';
      resolve(first.trim() || null);
    });
  });
}

function systemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: (os.cpus()[0] || {}).model || 'unknown',
    cpuCount: os.cpus().length,
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    uptimeSec: Math.round(os.uptime()),
    memTotalMB: Math.round(totalMem / (1024 * 1024)),
    memUsedMB: Math.round((totalMem - freeMem) / (1024 * 1024)),
    memPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    cpuPercent: systemCpuPercent(),
  };
}

module.exports = {
  systemInfo,
  systemCpuPercent,
  processStats,
  diskUsage,
  javaVersion,
};
