// index.js
// Lightweight daily scheduler. Runs the sector rotation scanner once per
// weekday at 4:15pm ET (after market close) so the daily bars are settled.
//
// Why this approach: Railway services run continuously, so we use a simple
// in-process scheduler rather than Railway's cron jobs. This keeps the whole
// thing one service, one deploy, one log stream.

const { run } = require('./sectorRotation');

const RUN_HOUR_ET = 16;   // 4 PM ET
const RUN_MINUTE = 15;    // :15 — gives bars time to settle

function nowInET() {
  // Convert current UTC time to ET (handles DST automatically via toLocaleString)
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
    weekday: get('weekday'),       // 'Mon', 'Tue', ...
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
  };
}

function isWeekday(wd) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd);
}

let lastRunDate = null; // 'YYYY-MM-DD' in ET — prevents double runs

function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(new Date()); // 'YYYY-MM-DD'
}

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

// Optional: run immediately on boot if RUN_ON_BOOT=true
async function main() {
  console.log('Sector rotation service starting...');
  console.log(`Schedule: weekdays at ${RUN_HOUR_ET}:${String(RUN_MINUTE).padStart(2, '0')} ET`);

  if (process.env.RUN_ON_BOOT === 'true') {
    console.log('RUN_ON_BOOT=true — running scan now');
    try {
      await run();
      lastRunDate = todayInET();
    } catch (e) {
      console.error('Boot run failed:', e.message);
    }
  }

  // Check every minute
  setInterval(tick, 60 * 1000);

  // Lightweight HTTP endpoint for Railway health checks + manual trigger
  const http = require('http');
  const PORT = process.env.PORT || 3000;
  http
    .createServer(async (req, res) => {
      if (req.url === '/run' && req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'text/plain' });
        res.end('Scan triggered\n');
        run().catch((e) => console.error('Manual run error:', e.message));
        return;
      }
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, lastRunDate }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(
        `Sector Rotation Service\n` +
          `Last run: ${lastRunDate || 'never'}\n` +
          `Schedule: weekdays ${RUN_HOUR_ET}:${String(RUN_MINUTE).padStart(2, '0')} ET\n` +
          `POST /run to trigger manually.\n`
      );
    })
    .listen(PORT, () => {
      console.log(`HTTP server listening on :${PORT}`);
    });
}

main();
