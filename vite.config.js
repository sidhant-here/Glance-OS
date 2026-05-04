import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import os from 'os'
import si from 'systeminformation'
import { spawn, exec } from 'child_process'
import readline from 'readline'
import path from 'path'
import { WebSocketServer } from 'ws'

// ─────────────────────────────────────────────
//  BACKEND STATE
// ─────────────────────────────────────────────

// Cache for slow-fetching properties
let diskStatsCache = null;

// Telemetry state
let netUpload = 0;   // KB/s
let netDownload = 0;  // KB/s

// EMA-smoothed network speed (prevents flicker)
let smoothNetUpload = 0;
let smoothNetDownload = 0;
const NET_EMA_ALPHA = 0.3; // 0 = very smooth, 1 = raw

// Windows Native state via powershell
let nativeState = {
    cpu: 0,
    disk_active: 0,
    disk_read: 0,
    disk_write: 0,
    mem_total: os.totalmem(),
    mem_used: 0,
    mem_free: 0,
    per_core: []
};
let nativeStateReady = false;  // true after first telemetry line arrives
let lastCpuValue = 0;          // hold-last-good CPU value

let load1 = 0;
let load5 = 0;
let load15 = 0;

// Swap memory
let swapTotal = 0;
let swapUsed = 0;

// Cached memory info (buffers/cached)
let memBuffers = 0;
let memCached = 0;

// Network connections count
let netConnections = 0;

// Per-core CPU from systeminformation (fallback for non-Windows)
let perCoreSI = [];

// Cached osInfo (static — only fetch once)
let osInfoCache = null;

// Cached process list (expensive — refresh every 2s)
let processCache = { all: 0, list: [] };
let pausedPids = new Set();

// Clamp helper
function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }

// ─────────────────────────────────────────────
//  DISK STATS CACHE (slow — refresh every 60s)
// ─────────────────────────────────────────────
function updateDiskStats() {
    si.fsSize().then(data => {
        diskStatsCache = data;
    }).catch(() => {});
}
updateDiskStats();
setInterval(updateDiskStats, 60000);

// ─────────────────────────────────────────────
//  SWAP MEMORY (refresh every 10s)
// ─────────────────────────────────────────────
function updateMemInfo() {
    si.mem().then(data => {
        swapTotal = data.swaptotal || 0;
        swapUsed = data.swapused || 0;
        memBuffers = data.buffers || 0;
        memCached = data.cached || 0;
    }).catch(() => {});
}
updateMemInfo();
setInterval(updateMemInfo, 5000);

// ─────────────────────────────────────────────
//  OS INFO CACHE (static — fetch once)
// ─────────────────────────────────────────────
si.osInfo().then(info => { osInfoCache = info; }).catch(() => {});

// ─────────────────────────────────────────────
//  PROCESS LIST CACHE (expensive — every 2s)
// ─────────────────────────────────────────────
function updateProcessCache() {
    si.processes().then(procs => {
        processCache = procs;
    }).catch(() => {});
}
updateProcessCache();
setInterval(updateProcessCache, 2000);

// ─────────────────────────────────────────────
//  NETWORK CONNECTIONS (refresh every 5s — expensive call)
// ─────────────────────────────────────────────
function updateNetConnections() {
    si.networkConnections().then(conns => {
        netConnections = conns ? conns.length : 0;
    }).catch(() => { netConnections = 0; });
}
updateNetConnections();
setInterval(updateNetConnections, 5000);

// ─────────────────────────────────────────────
//  GPU METRICS (refresh every 2s)
// ─────────────────────────────────────────────
let gpuTemp = 40;
let gpuLoad = 0;
function updateGpuMetrics() {
    si.graphics().then(data => {
        if (data && data.controllers) {
            const gpu = data.controllers.find(c => (c.vendor || '').toLowerCase().includes('nvidia')) || data.controllers[0];
            if (gpu.temperatureGpu !== undefined && gpu.temperatureGpu !== null) gpuTemp = gpu.temperatureGpu;
            if (gpu.utilizationGpu !== undefined && gpu.utilizationGpu !== null) gpuLoad = gpu.utilizationGpu;
        }
    }).catch(() => {});
}
updateGpuMetrics();
setInterval(updateGpuMetrics, 2000);

// ─────────────────────────────────────────────
//  POWERSHELL TELEMETRY STREAM (Windows only)
// ─────────────────────────────────────────────
const isWindows = os.platform() === 'win32';
if (isWindows) {
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'telemetry.ps1')]);
    
    readline.createInterface({ input: ps.stdout }).on('line', (line) => {
        try {
            const data = JSON.parse(line.trim());
            nativeState = { ...nativeState, ...data };
            nativeStateReady = true;

            // Hold last good CPU value (never go to 0 unless system truly idle)
            if (nativeState.cpu > 0.05) {
                lastCpuValue = nativeState.cpu;
            }
            
            // Re-calculate Unix load averages safely here
            const curLoadRaw = (nativeState.cpu / 100) * (os.cpus().length || 8);
            if (load1 === 0 && load5 === 0) {
                load1 = curLoadRaw;
                load5 = curLoadRaw;
                load15 = curLoadRaw;
            }
            load1 = load1 * (1 - 1/60) + curLoadRaw * (1/60);
            load5 = load5 * (1 - 1/300) + curLoadRaw * (1/300);
            load15 = load15 * (1 - 1/900) + curLoadRaw * (1/900);

        } catch (e) {
            // ignore malformed lines
        }
    });

    ps.stderr.on('data', (data) => { console.warn('⚙ telemetry.ps1:', data.toString().trim()); });
    ps.on('close', () => {
        console.error('warning: telemetry powershell process died');
    });
}

// ─────────────────────────────────────────────
//  CPU LOAD FALLBACK (non-Windows only — Windows uses telemetry.ps1 Get-Counter)
// ─────────────────────────────────────────────
let cpuNodeTotal = 0;
let cpuNodePerCore = [];

if (!isWindows) {
    let lastCpus = os.cpus();
    setInterval(() => {
        let cpus = os.cpus();
        let totalIdle = 0, totalTick = 0;
        let perCore = [];
        for (let i = 0; i < cpus.length; i++) {
            let cpu = cpus[i];
            let last = lastCpus[i] || cpu;
            let idle = cpu.times.idle - last.times.idle;
            let t1 = 0; for (let type in cpu.times) t1 += cpu.times[type];
            let t2 = 0; for (let type in last.times) t2 += last.times[type];
            let tick = t1 - t2;
            let load = tick === 0 ? 0 : (1 - idle / tick) * 100;
            perCore.push({ core: i, load: Math.round(load * 10) / 10 });
            totalIdle += idle;
            totalTick += tick;
        }
        cpuNodeTotal = totalTick === 0 ? 0 : (1 - totalIdle / totalTick) * 100;
        cpuNodePerCore = perCore;
        lastCpus = cpus;
    }, 1000);
}

// ─────────────────────────────────────────────
//  NETWORK SPEED (1s polling)
// ─────────────────────────────────────────────
// Prime systeminformation's network baseline (first call returns -1)
si.networkStats().catch(() => {});

setInterval(async () => {
    try {
        const netStats = await si.networkStats();
        if (netStats && netStats.length > 0) {
            let txBytesSec = 0;
            let rxBytesSec = 0;
            for (const intf of netStats) {
                if (typeof intf.tx_sec === 'number' && typeof intf.rx_sec === 'number') {
                    // Skip invalid first-call values (-1) and loopback spikes
                    if (intf.tx_sec > 0) txBytesSec += intf.tx_sec;
                    if (intf.rx_sec > 0) rxBytesSec += intf.rx_sec;
                }
            }
            
            const rawUp = txBytesSec / 1024;   // KB/s
            const rawDn = rxBytesSec / 1024;    // KB/s

            // EMA smoothing: prevents wild jumps between samples
            smoothNetUpload = smoothNetUpload === 0 ? rawUp : smoothNetUpload * (1 - NET_EMA_ALPHA) + rawUp * NET_EMA_ALPHA;
            smoothNetDownload = smoothNetDownload === 0 ? rawDn : smoothNetDownload * (1 - NET_EMA_ALPHA) + rawDn * NET_EMA_ALPHA;

            netUpload = Math.round(smoothNetUpload * 10) / 10;
            netDownload = Math.round(smoothNetDownload * 10) / 10;
        }
    } catch (err) {
    }
}, 1000);

// ─────────────────────────────────────────────
//  BUILD RESPONSE DATA (shared by HTTP + WS)
//  Now SYNCHRONOUS — uses cached data for perf
// ─────────────────────────────────────────────
function buildStateResponse() {
    // Map Disk storage stats
    let diskTotal = 512;
    let diskUsed = 240;
    let diskFree = 272;
    
    if (diskStatsCache && diskStatsCache.length > 0) {
        const mainDrive = diskStatsCache.find(d => d.mount === 'C:') || diskStatsCache[0];
        diskTotal = Math.round(mainDrive.size / (1024 * 1024 * 1024));
        diskUsed = Math.round(mainDrive.used / (1024 * 1024 * 1024));
        diskFree = diskTotal - diskUsed;
    }

    // Use cached process list (refreshed every 2s)
    const processes = processCache;
    const mappedProcs = (processes.list || []).map(p => {
        let st = p.state === 'running' ? 'Running' : (p.state === 'sleeping' ? 'Sleeping' : (p.state === 'stopped' ? 'Stopped' : 'Unknown'));
        if (pausedPids.has(p.pid)) {
           st = 'Stopped';
        } else if (st === 'Unknown' && p.cpu > 0) {
           st = 'Running';
        } else if (st === 'Unknown') {
           st = 'Sleeping';
        }
        return {
          pid: p.pid,
          name: p.name || 'Unknown',
          user: p.user || 'SYSTEM',
          cpu: Math.round(p.cpu * 10) / 10,
          mem: Math.round(p.mem * 10) / 10,
          status: st,
          threads: p.threads || 1
        };
    });

    // ── CPU: Use Native PerformanceCounters on Windows (Matches Task Manager) ──
    const cpuVal = (isWindows && nativeStateReady) ? clamp(nativeState.cpu) : Math.round(clamp(cpuNodeTotal) * 10) / 10;

    const memTotal = nativeState.mem_total || os.totalmem();
    const memUsed = nativeState.mem_used || (os.totalmem() - os.freemem());
    const memFree = nativeState.mem_free || os.freemem();

    const diskReadMB = Math.round((nativeState.disk_read / (1024 * 1024)) * 10) / 10;
    const diskWriteMB = Math.round((nativeState.disk_write / (1024 * 1024)) * 10) / 10;
    const diskActive = clamp(nativeState.disk_active);

    // Per-core: Use Native Windows counters if available
    let perCore = (isWindows && nativeStateReady && nativeState.per_core.length > 0) ? nativeState.per_core : cpuNodePerCore;

    // Use cached osInfo (static data)
    const oi = osInfoCache || {};

    const responseData = {
        cpu: {
          usage: cpuVal,
          cores: os.cpus().length,
          model: os.cpus()[0]?.model || 'Unknown',
          freq: `${os.cpus()[0]?.speed ? (os.cpus()[0].speed/1000).toFixed(2) : '2.9'} GHz`,
          loadAvg: [
              Math.round(load1 * 100) / 100,
              Math.round(load5 * 100) / 100,
              Math.round(load15 * 100) / 100
          ],
          perCore: perCore
        },
        memory: {
          total: Math.round((memTotal / (1024 * 1024 * 1024)) * 10) / 10,
          used: Math.round((memUsed / (1024 * 1024 * 1024)) * 10) / 10,
          free: Math.round((memFree / (1024 * 1024 * 1024)) * 10) / 10,
          cached: Math.round((memCached / (1024 * 1024 * 1024)) * 10) / 10,
          buffers: Math.round((memBuffers / (1024 * 1024 * 1024)) * 10) / 10,
          swap: {
            total: Math.round((swapTotal / (1024 * 1024 * 1024)) * 10) / 10,
            used: Math.round((swapUsed / (1024 * 1024 * 1024)) * 10) / 10,
          }
        },
        gpu: {
          temp: gpuTemp,
          load: gpuLoad
        },
        disk: {
          total: diskTotal,
          used: diskUsed,
          free: diskFree,
          usagePercent: Math.round(clamp(diskActive) * 10) / 10,
          read: diskReadMB,
          write: diskWriteMB
        },
        system: {
          os: oi.distro ? `${oi.distro} ${oi.release}` : os.type(),
          uptime: `${Math.floor(os.uptime() / 86400)}d ${Math.floor((os.uptime() % 86400) / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
          hostname: os.hostname(),
          ip: Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1',
          arch: os.arch()
        },
        network: {
          upload: Math.round((netUpload ?? 0) * 10) / 10,
          download: Math.round((netDownload ?? 0) * 10) / 10,
          connections: netConnections
        },
        processes: {
          total: processes.all || 0,
          running: mappedProcs.filter(p => p.status === 'Running').length,
          sleeping: mappedProcs.filter(p => p.status === 'Sleeping').length,
          zombie: mappedProcs.filter(p => p.status === 'Stopped' || p.status === 'Unknown').length,
          list: mappedProcs
        }
    };

    return responseData;
}

// ─────────────────────────────────────────────
//  WEBSOCKET SERVER (port 8765)
// ─────────────────────────────────────────────
let wss = null;
let wsInterval = null;

function startWebSocketServer() {
    if (wss) return; // already running
    try {
        wss = new WebSocketServer({ port: 8765 });
        console.log('📡 WebSocket server listening on ws://localhost:8765');

        wss.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn('⚠ Port 8765 in use, WebSocket server disabled (HTTP-only mode)');
                wss = null;
            }
        });

        wss.on('connection', (ws) => {
            console.log('🔗 WebSocket client connected');
            try {
                const data = buildStateResponse();
                if (ws.readyState === 1) ws.send(JSON.stringify(data));
            } catch(e) {}
        });

        // Broadcast to all clients every 500ms for snappy real-time updates
        // Only broadcast after telemetry.ps1 has delivered its first valid sample
        wsInterval = setInterval(() => {
            if (!wss || wss.clients.size === 0) return;
            if (!nativeStateReady) return; // Wait for first telemetry sample
            try {
                const data = buildStateResponse();
                const json = JSON.stringify(data);
                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(json);
                    }
                });
            } catch (err) {
                // silent
            }
        }, 500);
    } catch (err) {
        console.warn('⚠ WebSocket server failed to start:', err.message);
        wss = null;
    }
}

// ─────────────────────────────────────────────
//  VITE CONFIG
// ─────────────────────────────────────────────
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'real-os-metrics',
      configureServer(server) {
        // Start WebSocket server when Vite dev server starts
        startWebSocketServer();

        server.middlewares.use((req, res, next) => {
          if (req.url === '/api/state') {
            try {
              const responseData = buildStateResponse();
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-store');
              res.end(JSON.stringify(responseData));
            } catch (err) {
              console.error('Error fetching OS state:', err);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          } else if (req.url.startsWith('/api/kill/')) {
            const pidMatch = req.url.match(/\/api\/kill\/(\d+)/);
            if (pidMatch) {
              const pid = parseInt(pidMatch[1], 10);
              pausedPids.delete(pid);
              const cmd = isWindows ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`;
              
              exec(cmd, (err) => {
                res.setHeader('Content-Type', 'application/json');
                if (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ success: false, error: err.message }));
                } else {
                  res.end(JSON.stringify({ success: true }));
                }
              });
            } else {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid PID' }));
            }
          } else if (req.url.startsWith('/api/pause/') || req.url.startsWith('/api/resume/')) {
            const isPause = req.url.startsWith('/api/pause/');
            const action = isPause ? 'pause' : 'resume';
            const pidMatch = req.url.match(new RegExp(`/api/${action}/(\\d+)`));
            if (pidMatch) {
              const pid = parseInt(pidMatch[1], 10);
              const cmd = isWindows ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(process.cwd(), 'suspend.ps1')}" -Action ${action} -ProcessId ${pid}` : `kill -${isPause ? 'STOP' : 'CONT'} ${pid}`;
              
              exec(cmd, (err) => {
                res.setHeader('Content-Type', 'application/json');
                if (err && isWindows) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ success: false, error: err.message }));
                } else {
                  if (isPause) pausedPids.add(pid);
                  else pausedPids.delete(pid);
                  res.end(JSON.stringify({ success: true }));
                }
              });
            } else {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid PID' }));
            }
          } else {
            next();
          }
        });
      }
    }
  ],
})
