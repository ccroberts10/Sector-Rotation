// index.js
// Lightweight daily scheduler + HTTP server.
// Routes:
//   GET  /              - dashboard UI (public/index.html)
//   GET  /api/latest    - JSON of latest scan payload
//   GET  /healthz       - health check
//   POST /run           - manually trigger a scan

const fs = require('fs');
const path = require('path');
const http = require('http');
const { run, loadLatest } = require('./sectorRotation');

const RUN_HOUR_ET = 16;
const RUN_MINUTE = 15;
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function nowInET() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    weekday: get('weekday'),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
  };
}

function isWeekday(wd) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd);
}

function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(new Date());
}

let lastRunDate = null;

async function tick() {
  try {
    const { weekday, hour, minute } = nowInET();
    const today = todayInET();

    if (
      isWeekday(weekday) &&
      hour === RUN_HOUR_ET &&
      minute >= RUN_MINUTE &&
      lastRunDate !== today
    ) {
      console.log(`[Scheduler] Triggering scan at ${today} ${hour}:${minute} ET`);
      lastRunDate = today;
      await run();
    }
  } catch (e) {
    console.error('[Scheduler] tick error:', e.message);
  }
}

// --- Static file serving ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, filepath) {
  fs.readFile(filepath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filepath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

async function main() {
  console.log('Sector rotation service starting...');
  console.log(`Schedule: weekdays at ${RUN_HOUR_ET}:${String(RUN_MINUTE).padStart(2, '0')} ET`);
  console.log(`Static UI: ${PUBLIC_DIR}`);

  if (process.env.RUN_ON_BOOT === 'true') {
    console.log('RUN_ON_BOOT=true — running scan now');
    try {
      await run();
      lastRunDate = todayInET();
    } catch (e) {
      console.error('Boot run failed:', e.message);
    }
  }

  setInterval(tick, 60 * 1000);

  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      if (pathname === '/api/latest') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        const data = loadLatest();
        if (data) {
          res.end(JSON.stringify(data));
        } else {
          res.end(JSON.stringify({ empty: true, timestamp: null }));
        }
        return;
      }

      if (pathname === '/run' && req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'text/plain' });
        res.end('Scan triggered\n');
        run().catch((e) => console.error('Manual run error:', e.message));
        return;
      }

      if (pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, lastRunDate }));
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        return serveStatic(req, res, path.join(PUBLIC_DIR, 'index.html'));
      }

      // Other static assets
      if (pathname.match(/\.(css|js|svg|png|ico)$/)) {
        const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
        const filepath = path.join(PUBLIC_DIR, safePath);
        if (filepath.startsWith(PUBLIC_DIR)) {
          return serveStatic(req, res, filepath);
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    })
    .listen(PORT, () => {
      console.log(`HTTP server listening on :${PORT}`);
    });
}

main();
