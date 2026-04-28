// sectorRotation.js
// Standalone sector rotation scanner.
//
// What it does each run:
//   1. Pulls daily bars for the 11 SPDR sector ETFs + SPY benchmark + XBI/IBB.
//   2. Computes 1-week, 1-month, 3-month relative strength vs SPY.
//   3. Builds a composite RS score, ranks sectors top-to-bottom.
//   4. Computes biotech-specific signal (XBI/SPY trend + XBI/IBB risk-on confirm).
//   5. Compares today's ranking vs saved snapshot, flags rotation shifts.
//   6. Sends a Pushover alert with rankings, leaders, laggards, and shifts.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { buildRegimeCard } = require('./regimeAdjustment');
const { generateRecap } = require('./aiRecap');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SECTOR_ETFS = {
  XLK: 'Technology',
  XLF: 'Financials',
  XLE: 'Energy',
  XLV: 'Healthcare',
  XLY: 'Consumer Discretionary',
  XLP: 'Consumer Staples',
  XLI: 'Industrials',
  XLB: 'Materials',
  XLU: 'Utilities',
  XLRE: 'Real Estate',
  XLC: 'Communication Services',
};

const EXTRA_TICKERS = ['XBI', 'IBB'];
const BENCHMARK = 'SPY';

const ALL_TICKERS = [
  BENCHMARK,
  ...Object.keys(SECTOR_ETFS),
  ...EXTRA_TICKERS,
];

const LOOKBACKS = {
  week: 5,
  month: 21,
  quarter: 63,
};

// Composite weights — tilted toward 1-month for actionable rotation signals
const WEIGHTS = { week: 0.2, month: 0.5, quarter: 0.3 };

const RANK_SHIFT_THRESHOLD = 3;

// Use Railway volume mount if available, fall back to local dir
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const SNAPSHOT_PATH = path.join(DATA_DIR, 'sectorRotationSnapshot.json');
const LATEST_PATH = path.join(DATA_DIR, 'sectorRotationLatest.json');

// ---------------------------------------------------------------------------
// Tradier fetch
// ---------------------------------------------------------------------------

function tradierGet(pathStr) {
  return new Promise((resolve, reject) => {
    const token = process.env.TRADIER_TOKEN || process.env.TRADIER_API_KEY;
    if (!token) return reject(new Error('TRADIER_TOKEN not set'));

    const opts = {
      hostname: 'api.tradier.com',
      path: pathStr,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    };

    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Tradier parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchHistory(symbol, days = 100) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days * 1.6);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `/v1/markets/history?symbol=${symbol}&interval=daily&start=${fmt(start)}&end=${fmt(end)}`;

  const res = await tradierGet(url);
  const days_ = res?.history?.day;
  if (!days_) throw new Error(`No history for ${symbol}`);
  const arr = Array.isArray(days_) ? days_ : [days_];
  return arr.map((d) => ({ date: d.date, close: parseFloat(d.close) }));
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function pctChange(bars, lookback) {
  if (bars.length < lookback + 1) return null;
  const now = bars[bars.length - 1].close;
  const then = bars[bars.length - 1 - lookback].close;
  if (!then) return null;
  return ((now - then) / then) * 100;
}

function relativeStrength(sectorBars, spyBars, lookback) {
  const sectorPct = pctChange(sectorBars, lookback);
  const spyPct = pctChange(spyBars, lookback);
  if (sectorPct === null || spyPct === null) return null;
  return sectorPct - spyPct;
}

function ratioTrend(numBars, denBars, lookback) {
  if (numBars.length < lookback + 1 || denBars.length < lookback + 1) return null;
  const ratioNow = numBars[numBars.length - 1].close / denBars[denBars.length - 1].close;
  const ratioThen =
    numBars[numBars.length - 1 - lookback].close /
    denBars[denBars.length - 1 - lookback].close;
  return ((ratioNow - ratioThen) / ratioThen) * 100;
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('Snapshot load failed:', e.message);
  }
  return null;
}

function saveSnapshot(rankings) {
  const snap = {
    timestamp: new Date().toISOString(),
    ranks: rankings.reduce((acc, r, i) => {
      acc[r.ticker] = i + 1;
      return acc;
    }, {}),
    composites: rankings.reduce((acc, r) => {
      acc[r.ticker] = parseFloat(r.composite.toFixed(2));
      return acc;
    }, {}),
  };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
}

function saveLatest(payload) {
  // Persistent JSON of the full latest scan, used by the web UI
  fs.writeFileSync(LATEST_PATH, JSON.stringify(payload, null, 2));
}

function loadLatest() {
  try {
    if (fs.existsSync(LATEST_PATH)) {
      return JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('Latest load failed:', e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pushover
// ---------------------------------------------------------------------------

function sendPushover(title, message) {
  return new Promise((resolve) => {
    const token = process.env.PUSHOVER_TOKEN;
    const user = process.env.PUSHOVER_USER;
    if (!token || !user) {
      console.log('[Pushover not configured — skipping alert]');
      console.log(`TITLE: ${title}`);
      console.log(message);
      return resolve();
    }

    const payload = new URLSearchParams({
      token,
      user,
      title,
      message,
    }).toString();

    const req = https.request(
      {
        hostname: 'api.pushover.net',
        path: '/1/messages.json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', (e) => {
      console.warn('Pushover error:', e.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log('=== Sector Rotation Scanner ===');
  console.log('Run time:', new Date().toISOString());
  console.log('Data dir:', DATA_DIR);
  console.log('Fetching bars for', ALL_TICKERS.length, 'tickers...');

  const data = {};
  for (const t of ALL_TICKERS) {
    try {
      data[t] = await fetchHistory(t, 100);
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      console.warn(`Failed to fetch ${t}:`, e.message);
    }
  }

  const spy = data[BENCHMARK];
  if (!spy) throw new Error('No SPY data — cannot compute relative strength.');

  // --- Sector rankings ---
  const rows = [];
  for (const [ticker, name] of Object.entries(SECTOR_ETFS)) {
    const bars = data[ticker];
    if (!bars) continue;

    const wk = relativeStrength(bars, spy, LOOKBACKS.week);
    const mo = relativeStrength(bars, spy, LOOKBACKS.month);
    const qt = relativeStrength(bars, spy, LOOKBACKS.quarter);
    if (wk === null || mo === null || qt === null) continue;

    const composite = wk * WEIGHTS.week + mo * WEIGHTS.month + qt * WEIGHTS.quarter;
    rows.push({ ticker, name, wk, mo, qt, composite });
  }

  rows.sort((a, b) => b.composite - a.composite);

  // --- Biotech-specific read ---
  let biotechBlock = '';
  let biotechSignal = 'UNKNOWN';
  let biotechRatios = {};
  if (data.XBI && data.IBB && spy) {
    const xbiSpyMo = ratioTrend(data.XBI, spy, LOOKBACKS.month);
    const xbiSpyQt = ratioTrend(data.XBI, spy, LOOKBACKS.quarter);
    const xbiIbbMo = ratioTrend(data.XBI, data.IBB, LOOKBACKS.month);
    biotechRatios = { xbiSpyMo, xbiSpyQt, xbiIbbMo };

    biotechSignal = 'NEUTRAL';
    if (xbiSpyMo > 0 && xbiSpyQt > 0 && xbiIbbMo > 0) biotechSignal = 'ROTATION IN';
    else if (xbiSpyMo > 0 && xbiIbbMo > 0) biotechSignal = 'EARLY POSITIVE';
    else if (xbiSpyMo < 0 && xbiSpyQt < 0) biotechSignal = 'STILL OUT';

    biotechBlock =
      `\nBIOTECH READ: ${biotechSignal}\n` +
      `  XBI/SPY 1mo: ${xbiSpyMo.toFixed(2)}%   3mo: ${xbiSpyQt.toFixed(2)}%\n` +
      `  XBI/IBB 1mo: ${xbiIbbMo.toFixed(2)}%  (>0 = risk-on speculative biotech)\n`;
  }

  // --- Rank shift detection ---
  const prev = loadSnapshot();
  const shifts = [];
  if (prev?.ranks) {
    rows.forEach((r, i) => {
      const newRank = i + 1;
      const oldRank = prev.ranks[r.ticker];
      if (oldRank && Math.abs(oldRank - newRank) >= RANK_SHIFT_THRESHOLD) {
        shifts.push({
          ticker: r.ticker,
          name: r.name,
          old: oldRank,
          new: newRank,
          dir: oldRank > newRank ? 'UP' : 'DOWN',
        });
      }
    });
  }

  // --- Format output ---
  const top3 = rows.slice(0, 3);
  const bot3 = rows.slice(-3).reverse();

  let msg = 'SECTOR RANKINGS (composite RS vs SPY)\n';
  msg += '------------------------------------\n';
  rows.forEach((r, i) => {
    msg +=
      `${String(i + 1).padStart(2)}. ${r.ticker.padEnd(5)} ` +
      `comp:${r.composite.toFixed(2).padStart(7)}  ` +
      `1w:${r.wk.toFixed(2).padStart(6)}  1m:${r.mo.toFixed(2).padStart(6)}  3m:${r.qt.toFixed(2).padStart(6)}\n`;
  });

  msg += `\nLEADERS: ${top3.map((r) => r.ticker).join(', ')}\n`;
  msg += `LAGGARDS: ${bot3.map((r) => r.ticker).join(', ')}\n`;
  msg += biotechBlock;

  if (shifts.length) {
    msg += '\nRANK SHIFTS (>=' + RANK_SHIFT_THRESHOLD + ' positions):\n';
    shifts.forEach((s) => {
      msg += `  ${s.dir} ${s.ticker}: #${s.old} -> #${s.new}\n`;
    });
  } else if (prev) {
    msg += '\nNo significant rank shifts vs last run.\n';
  } else {
    msg += '\n(First run - no prior snapshot to compare.)\n';
  }

  // --- Regime card (static rule engine) ---
  const regimeCard = buildRegimeCard(rows, biotechSignal, shifts);
  msg += regimeCard.text;

  // --- AI recap (Claude API, optional) ---
  console.log('Generating AI recap...');
  const recap = await generateRecap({
    rows,
    biotechSignal,
    shifts,
    regime: regimeCard.regime,
  });
  if (recap) {
    msg = `AI RECAP\n------------------------------------\n${recap}\n\n` + msg;
  }

  console.log('\n' + msg);

  // --- Alert and save ---
  const title = shifts.length
    ? `Sector Rotation: ${shifts.length} shift(s)`
    : `Sector Rotation: ${top3[0].ticker} leading`;

  await sendPushover(title, msg);
  saveSnapshot(rows);

  // Save full structured payload for the web UI
  saveLatest({
    timestamp: new Date().toISOString(),
    recap: recap || '',
    regime: regimeCard.regime,
    buckets: regimeCard.buckets,
    actions: regimeCard.actions,
    biotechSignal,
    biotechRatios,
    rows: rows.map((r) => ({
      ticker: r.ticker,
      name: r.name,
      wk: parseFloat(r.wk.toFixed(2)),
      mo: parseFloat(r.mo.toFixed(2)),
      qt: parseFloat(r.qt.toFixed(2)),
      composite: parseFloat(r.composite.toFixed(2)),
    })),
    shifts,
  });

  console.log('Snapshot saved to', SNAPSHOT_PATH);
  console.log('=== Done ===');
}

if (require.main === module) {
  run().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}

module.exports = { run, loadLatest };
