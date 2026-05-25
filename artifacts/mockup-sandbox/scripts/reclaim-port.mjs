#!/usr/bin/env node
import { readlinkSync, readFileSync, readdirSync } from "node:fs";

const rawPort = process.env.PORT;
if (!rawPort) {
  console.error("[reclaim-port] PORT env var not set; skipping.");
  process.exit(0);
}
const port = Number(rawPort);
if (!Number.isFinite(port) || port <= 0) {
  console.error(`[reclaim-port] Invalid PORT value: "${rawPort}"`);
  process.exit(1);
}

const TCP_LISTEN_STATE = "0A";

function parseTcpFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").slice(1);
  const entries = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const localAddr = parts[1];
    const state = parts[3];
    const inode = parts[9];
    if (state !== TCP_LISTEN_STATE) continue;
    const colonIdx = localAddr.lastIndexOf(":");
    if (colonIdx < 0) continue;
    const portHex = localAddr.slice(colonIdx + 1);
    const p = parseInt(portHex, 16);
    if (!Number.isFinite(p)) continue;
    entries.push({ port: p, inode });
  }
  return entries;
}

function inodesListeningOn(p) {
  const all = [
    ...parseTcpFile("/proc/net/tcp"),
    ...parseTcpFile("/proc/net/tcp6"),
  ];
  return new Set(all.filter((e) => e.port === p).map((e) => e.inode));
}

function pidsHoldingInodes(inodes) {
  if (inodes.size === 0) return [];
  const pids = new Set();
  let procEntries;
  try {
    procEntries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const name of procEntries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) {
        pids.add(pid);
        break;
      }
    }
  }
  return [...pids];
}

function findPidsOnPort(p) {
  return pidsHoldingInodes(inodesListeningOn(p));
}

function describePid(pid) {
  let exe = "";
  try {
    exe = readlinkSync(`/proc/${pid}/exe`);
  } catch {}
  let cwd = "";
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {}
  let cmdline = "";
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replace(/\0/g, " ")
      .trim();
  } catch {}
  return { pid, exe, cwd, cmdline };
}

function isOurStaleVite(info) {
  const looksLikeNode =
    /\/node$/.test(info.exe) || /\bnode\b/.test(info.cmdline);
  const mentionsVite = /\bvite\b/.test(info.cmdline);
  const workspace = process.cwd();
  const inWorkspace =
    info.cwd === workspace ||
    info.cwd.startsWith(`${workspace}/`) ||
    info.cmdline.includes(workspace);
  return looksLikeNode && mentionsVite && inWorkspace;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, Math.min(50, end - Date.now()));
    } catch {
      const spinEnd = Date.now() + 10;
      while (Date.now() < spinEnd) {}
    }
  }
}

function waitForFree(p, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findPidsOnPort(p).length === 0) return true;
    sleepSync(100);
  }
  return findPidsOnPort(p).length === 0;
}

const pids = findPidsOnPort(port);
if (pids.length === 0) {
  console.log(`[reclaim-port] Port ${port} is free.`);
  process.exit(0);
}

const infos = pids.map(describePid);
const ours = infos.filter(isOurStaleVite);
const foreign = infos.filter((i) => !isOurStaleVite(i));

if (foreign.length > 0) {
  console.error(
    `[reclaim-port] Port ${port} is held by an unknown process; refusing to kill.`,
  );
  for (const i of foreign) {
    console.error(
      `[reclaim-port]   pid=${i.pid} exe=${i.exe || "?"} cwd=${i.cwd || "?"} cmd=${i.cmdline || "?"}`,
    );
  }
  console.error(
    `[reclaim-port] Investigate manually (e.g. \`kill <pid>\`) and retry.`,
  );
  process.exit(1);
}

for (const i of ours) {
  console.log(
    `[reclaim-port] Reclaiming port ${port} from stale vite pid=${i.pid} cwd=${i.cwd}`,
  );
  try {
    process.kill(i.pid, "SIGTERM");
  } catch (err) {
    console.warn(`[reclaim-port] SIGTERM pid=${i.pid} failed: ${err.message}`);
  }
}

if (!waitForFree(port, 3000)) {
  for (const i of ours) {
    try {
      process.kill(i.pid, 0);
    } catch {
      continue;
    }
    console.log(`[reclaim-port] pid=${i.pid} still alive; sending SIGKILL.`);
    try {
      process.kill(i.pid, "SIGKILL");
    } catch (err) {
      console.warn(
        `[reclaim-port] SIGKILL pid=${i.pid} failed: ${err.message}`,
      );
    }
  }
  if (!waitForFree(port, 2000)) {
    console.error(
      `[reclaim-port] Port ${port} is still in use after SIGKILL; aborting.`,
    );
    process.exit(1);
  }
}

console.log(`[reclaim-port] Port ${port} reclaimed.`);
