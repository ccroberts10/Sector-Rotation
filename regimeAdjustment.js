// regimeAdjustment.js
// Static rule engine that maps sector rankings into actionable SIGNAL sizing
// adjustments. No API calls, no dependencies. Pure logic on top of rows[].
//
// Output: a structured "regime card" with regime classification + per-ticker
// guidance for the SIGNAL watchlist.

// SIGNAL watchlist mapped to sector ETFs.
// Update this if the watchlist changes.
const TICKER_TO_SECTOR = {
  // Tech
  AAPL: 'XLK', NVDA: 'XLK', MSFT: 'XLK', AMD: 'XLK',
  MU: 'XLK', MRVL: 'XLK', POET: 'XLK', AAOI: 'XLK',
  VIAV: 'XLK', MXL: 'XLK', RMBS: 'XLK', OPTX: 'XLK',
  VICR: 'XLK',
  // Communication Services
  GOOGL: 'XLC', META: 'XLC',
  // Consumer Discretionary
  AMZN: 'XLY', TSLA: 'XLY',
  // Materials
  ATOM: 'XLB',
  // Industrials/Materials (METC = met coal, fits XLB)
  METC: 'XLB',
};

// Defensive sectors — when these dominate top 3, regime is risk-off
const DEFENSIVE = ['XLP', 'XLU', 'XLV', 'XLRE'];
// Risk-on sectors — when these dominate top 3, regime is risk-on
const RISK_ON = ['XLK', 'XLY', 'XLC', 'XLF'];

function classifyRegime(rows) {
  const top3 = rows.slice(0, 3).map((r) => r.ticker);
  const defCount = top3.filter((t) => DEFENSIVE.includes(t)).length;
  const riskCount = top3.filter((t) => RISK_ON.includes(t)).length;

  if (defCount >= 2) return 'RISK-OFF';
  if (riskCount >= 2) return 'RISK-ON';
  return 'MIXED';
}

// Returns sizing multiplier for a ticker based on its sector's rank
function sizingFor(ticker, rankByEtf) {
  const sector = TICKER_TO_SECTOR[ticker];
  if (!sector) return { mult: 1.0, note: 'no sector mapping' };
  const rank = rankByEtf[sector];
  if (!rank) return { mult: 1.0, note: 'sector not ranked' };

  if (rank <= 3) return { mult: 1.25, note: `${sector} #${rank} — tailwind, size up` };
  if (rank <= 6) return { mult: 1.0, note: `${sector} #${rank} — neutral, normal size` };
  if (rank <= 8) return { mult: 0.75, note: `${sector} #${rank} — headwind, trim size` };
  return { mult: 0.5, note: `${sector} #${rank} — strong headwind, half size or skip` };
}

function buildRegimeCard(rows, biotechSignal, shifts) {
  const regime = classifyRegime(rows);
  const top3 = rows.slice(0, 3);
  const bot3 = rows.slice(-3).reverse();

  // Map ETF -> rank
  const rankByEtf = rows.reduce((acc, r, i) => {
    acc[r.ticker] = i + 1;
    return acc;
  }, {});

  // Group SIGNAL tickers by sizing bucket
  const buckets = { up: [], normal: [], trim: [], skip: [] };
  for (const ticker of Object.keys(TICKER_TO_SECTOR)) {
    const { mult } = sizingFor(ticker, rankByEtf);
    if (mult >= 1.25) buckets.up.push(ticker);
    else if (mult >= 1.0) buckets.normal.push(ticker);
    else if (mult >= 0.75) buckets.trim.push(ticker);
    else buckets.skip.push(ticker);
  }

  // Action items
  const actions = [];

  // Regime-level
  if (regime === 'RISK-OFF') {
    actions.push('REGIME: Risk-off. Demand higher conviction scores. Tighten stops. Take profits earlier.');
  } else if (regime === 'RISK-ON') {
    actions.push('REGIME: Risk-on. Full size on high-conviction setups. Give winners more room.');
  } else {
    actions.push('REGIME: Mixed. Trade normally — no regime-level adjustment.');
  }

  // Biotech
  if (biotechSignal === 'ROTATION IN') {
    actions.push('BIOTECH: Rotation confirmed. Add 2-4 biotech names to watchlist (LLY, REGN, VRTX, MRNA candidates) or trade XBI directly.');
  } else if (biotechSignal === 'EARLY POSITIVE') {
    actions.push('BIOTECH: Early positive read. Start research, prep watchlist additions, no trade yet.');
  } else if (biotechSignal === 'STILL OUT') {
    actions.push('BIOTECH: Still out of favor. Skip — do not waste watchlist slots.');
  }

  // Shifts — call out the actionable ones
  const upShifts = shifts.filter((s) => s.dir === 'UP');
  const downShifts = shifts.filter((s) => s.dir === 'DOWN');
  if (upShifts.length) {
    const tickers = upShifts.map((s) => `${s.ticker} (#${s.old}->#${s.new})`).join(', ');
    actions.push(`ROTATION INTO: ${tickers}. Research top names in these sectors for watchlist adds.`);
  }
  if (downShifts.length) {
    const tickers = downShifts.map((s) => `${s.ticker} (#${s.old}->#${s.new})`).join(', ');
    actions.push(`ROTATION OUT: ${tickers}. Trim exposure or reduce sizing in these sectors.`);
  }

  // Format the card text
  let card = '\nREGIME CARD\n';
  card += '------------------------------------\n';
  card += `Regime: ${regime}\n`;
  card += `Leaders: ${top3.map((r) => r.ticker).join(', ')}\n`;
  card += `Laggards: ${bot3.map((r) => r.ticker).join(', ')}\n`;
  card += `Biotech: ${biotechSignal}\n\n`;

  card += 'SIGNAL WATCHLIST SIZING:\n';
  if (buckets.up.length) card += `  SIZE UP (1.25x):   ${buckets.up.join(', ')}\n`;
  if (buckets.normal.length) card += `  NORMAL (1.0x):     ${buckets.normal.join(', ')}\n`;
  if (buckets.trim.length) card += `  TRIM (0.75x):      ${buckets.trim.join(', ')}\n`;
  if (buckets.skip.length) card += `  HALF/SKIP (0.5x):  ${buckets.skip.join(', ')}\n`;

  card += '\nACTIONS:\n';
  actions.forEach((a, i) => {
    card += `  ${i + 1}. ${a}\n`;
  });

  return {
    regime,
    buckets,
    actions,
    text: card,
  };
}

module.exports = { buildRegimeCard, classifyRegime, sizingFor, TICKER_TO_SECTOR };
