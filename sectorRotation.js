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
const { buildRiskRegime } = require('./riskRegime');
const { buildCapitulation } = require('./capitulation');

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

// XBI/IBB for biotech read
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
// Alpaca historical bars fetch
// ---------------------------------------------------------------------------
// Uses Alpaca's /v2/stocks/bars endpoint. Daily bars are free on both paper
// and live accounts. Supports multiple env var naming conventions.

function alpacaCreds() {
  const key =
    process.env.ALPACA_KEY ||
    process.env.ALPACA_API_KEY ||
    process.env.APCA_API_KEY_ID;
  const secret =
    process.env.ALPACA_SECRET ||
    process.env.ALPACA_SECRET_KEY ||
    process.env.APCA_API_SECRET_KEY;
  return { key, secret };
}

function alpacaGet(pathStr) {
  return new Promise((resolve, reject) => {
    const { key, secret } = alpacaCreds();
    if (!key || !secret) {
      return reject(
        new Error(
          'Alpaca creds not set. Expected ALPACA_KEY and ALPACA_SECRET in env.'
        )
      );
    }

    const opts = {
      hostname: 'data.alpaca.markets',
      path: pathStr,
      method: 'GET',
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
        Accept: 'application/json',
      },
    };

    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) {
            return reject(
              new Error(
                `Alpaca ${res.statusCode}: ${parsed.message || JSON.stringify(parsed)}`
              )
            );
          }
          resolve(parsed);
        } catch (e) {
          reject(
            new Error(`Alpaca parse error: ${e.message} (status ${res.statusCode})`)
          );
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchHistory(symbol, days = 100) {
  const end = new Date();
  // Back off the end time slightly to avoid edge-of-data issues
  end.setMinutes(end.getMinutes() - 20);
  const start = new Date();
  start.setDate(start.getDate() - days * 1.6);

  const url =
    `/v2/stocks/${encodeURIComponent(symbol)}/bars` +
    `?start=${encodeURIComponent(start.toISOString())}` +
    `&end=${encodeURIComponent(end.toISOString())}` +
    `&timeframe=1Day` +
    `&limit=1000` +
    `&adjustment=raw` +
    `&feed=iex`;

  const res = await alpacaGet(url);
  const bars = res?.bars;
  if (!bars || !Array.isArray(bars) || bars.length === 0) {
    throw new Error(`No history for ${symbol}`);
  }

  // Alpaca returns: [{ t: "2024-01-02T05:00:00Z", o, h, l, c, v, n, vw }, ...]
  return bars.map((b) => ({
    date: b.t.slice(0, 10),
    close: parseFloat(b.c),
  }));
}

// ---------------------------------------------------------------------------
// Index data fetch — FRED API
// ---------------------------------------------------------------------------
// FRED (St. Louis Fed) is the bulletproof free source for index data. Free
// API key, no rate limits for daily polling, decades of stable history.
// Register at: https://fred.stlouisfed.org/docs/api/api_key.html
// Then set FRED_API_KEY in Railway Variables.
//
// What we fetch:
//   - VIXCLS = CBOE Volatility Index (^VIX)
//   - VXVCLS = CBOE 3-Month Volatility Index (^VXV)
//   - VIX/VXV ratio replaces the unreliable Put/Call as our fear-spike signal.
//     When near-term implied vol > 3-month implied vol (ratio > 1), that's
//     short-term fear pricing higher than longer-term — same contrarian read.

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function httpsGet(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// --- FRED API: fetch a series' recent observations
async function fetchFredSeries(seriesId, days = 90) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.warn(`  FRED ${seriesId}: FRED_API_KEY not set`);
    return null;
  }

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: 'json',
    observation_start: fmt(start),
    observation_end: fmt(end),
    sort_order: 'asc',
  });

  try {
    const opts = {
      hostname: 'api.stlouisfed.org',
      path: `/fred/series/observations?${params}`,
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    };
    const { statusCode, body } = await httpsGet(opts);
    if (statusCode !== 200) {
      console.warn(`  FRED ${seriesId}: HTTP ${statusCode}`);
      return null;
    }
    const parsed = JSON.parse(body);
    const obs = parsed?.observations || [];
    const bars = [];
    for (const o of obs) {
      const v = parseFloat(o.value);
      if (isNaN(v) || o.value === '.') continue;  // FRED uses '.' for missing
      bars.push({ date: o.date, close: v });
    }
    if (bars.length === 0) {
      console.warn(`  FRED ${seriesId}: no valid observations`);
      return null;
    }
    console.log(`  FRED ${seriesId}: ${bars.length} obs`);
    return bars;
  } catch (e) {
    console.warn(`  FRED ${seriesId}: ${e.message || '(empty)'}`);
    return null;
  }
}

// --- VIX from FRED
async function fetchVix() {
  return fetchFredSeries('VIXCLS', 90);
}

// --- VIX/VXV ratio — fetch both, compute aligned ratio series
// Replaces CPC. Same fundamental signal: when short-term fear spikes above
// longer-term, contrarians get interested.
async function fetchVixVxvRatio() {
  const [vix, vxv] = await Promise.all([
    fetchFredSeries('VIXCLS', 90),
    fetchFredSeries('VXVCLS', 90),
  ]);
  if (!vix || !vxv) return null;

  // Build a date-indexed map for VXV so we can align
  const vxvByDate = {};
  vxv.forEach((b) => { vxvByDate[b.date] = b.close; });

  const bars = [];
  for (const v of vix) {
    const vxvVal = vxvByDate[v.date];
    if (!vxvVal || vxvVal <= 0) continue;
    bars.push({ date: v.date, close: v.close / vxvVal });
  }
  if (bars.length === 0) {
    console.warn('  VIX/VXV ratio: no aligned dates');
    return null;
  }
  console.log(`  VIX/VXV: ${bars.length} aligned ratio bars`);
  return bars;
}

// Keep the fetchCpc name for backward compatibility but route to the new signal
async function fetchCpc() {
  return fetchVixVxvRatio();
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
      data[t] = await fetchHistory(t, 250);
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      console.warn(`Failed to fetch ${t}:`, e.message);
    }
  }

  // Fetch VIX + CPC (NYMO/TRIN replaced with sector breadth from existing data)
  console.log('Fetching VIX + CPC...');
  const [vix, cpc] = await Promise.all([
    fetchVix(),
    fetchCpc(),
  ]);
  data.VIX = vix;
  data.CPC = cpc;

  if (data.VIX) console.log(`VIX last close: ${data.VIX[data.VIX.length - 1]?.close?.toFixed(2)}`);
  if (data.CPC) console.log(`CPC last close: ${data.CPC[data.CPC.length - 1]?.close?.toFixed(2)}`);

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

  // --- Risk regime overlay (defensive composite, XLY/XLP, SPY trend, VIX, velocity) ---
  const riskRegime = buildRiskRegime(rows, data);

  // --- Capitulation watch (VIX, CPC, sector breadth) ---
  const capitulation = buildCapitulation(data, Object.keys(SECTOR_ETFS));

  // Append a compact risk read to the message
  msg += '\nRISK REGIME\n------------------------------------\n';
  msg += `Verdict: ${riskRegime.verdict.verdict} (score ${riskRegime.verdict.score})\n`;
  if (riskRegime.defensive) {
    msg += `Defensives avg rank: ${riskRegime.defensive.avgRank} — ${riskRegime.defensive.signal}\n`;
  }
  if (riskRegime.xlyXlp) {
    msg += `XLY/XLP 1m: ${riskRegime.xlyXlp.change1m}% — ${riskRegime.xlyXlp.signal}\n`;
  }
  if (riskRegime.spyTrend) {
    const s = riskRegime.spyTrend;
    msg += `SPY: ${s.trend} (50DMA ${s.pctFromMa50 >= 0 ? '+' : ''}${s.pctFromMa50}%, 200DMA ${s.pctFromMa200 >= 0 ? '+' : ''}${s.pctFromMa200}%)\n`;
    if (s.vixLevel !== null) {
      msg += `VIX: ${s.vixLevel} — ${s.vixSignal}\n`;
    }
  }
  if (riskRegime.velocity.length) {
    msg += `Velocity flags: ${riskRegime.velocity.map((v) => `${v.ticker} ${v.type}`).join(', ')}\n`;
  }
  if (riskRegime.verdict.reasons.length) {
    msg += `Why: ${riskRegime.verdict.reasons.join('; ')}\n`;
  }

  // Append capitulation read
  msg += '\nCAPITULATION WATCH\n------------------------------------\n';
  msg += `Verdict: ${capitulation.verdict.verdict} (score ${capitulation.verdict.score})\n`;
  if (capitulation.vix) {
    msg += `VIX: ${capitulation.vix.value} — ${capitulation.vix.signal}\n`;
  }
  if (capitulation.cpc) {
    msg += `P/C Ratio: ${capitulation.cpc.value} — ${capitulation.cpc.signal}\n`;
  }
  if (capitulation.breadth) {
    msg += `Sector breadth: ${capitulation.breadth.below}/${capitulation.breadth.total} below 20DMA — ${capitulation.breadth.signal}\n`;
  }
  if (capitulation.verdict.reasons.length) {
    msg += `Why: ${capitulation.verdict.reasons.join('; ')}\n`;
  }

  // --- AI recap (Claude API, optional) ---
  console.log('Generating AI recap...');
  const recap = await generateRecap({
    rows,
    biotechSignal,
    shifts,
    regime: regimeCard.regime,
    riskRegime,
    capitulation,
  });
  if (recap) {
    msg = `AI RECAP\n------------------------------------\n${recap}\n\n` + msg;
  }

  console.log('\n' + msg);

  // --- Alert and save ---
  // Lead the title with the most actionable verdict
  let title;
  if (capitulation.verdict.verdict === 'BOUNCE SETUP') {
    title = `🟢 BOUNCE SETUP — ${capitulation.verdict.firing.join('+')}`;
  } else if (riskRegime.verdict.verdict === 'TAKE RISK OFF') {
    title = `⚠️ TAKE RISK OFF — ${regimeCard.regime}`;
  } else if (riskRegime.verdict.verdict === 'CAUTION') {
    title = `⚠️ CAUTION — ${top3[0].ticker} leading`;
  } else if (capitulation.verdict.verdict === 'OVERSOLD') {
    title = `🟡 Oversold — ${capitulation.verdict.firing.join('+')}`;
  } else if (shifts.length) {
    title = `Sector Rotation: ${shifts.length} shift(s)`;
  } else {
    title = `Sector Rotation: ${top3[0].ticker} leading`;
  }

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
    riskRegime,
    capitulation,
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
