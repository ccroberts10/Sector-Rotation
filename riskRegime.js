// riskRegime.js
// Layer of risk-off / risk-on detection on top of the rotation rankings.
// Pure functions — takes data already fetched by the scanner and produces
// a structured "risk read" that the regime card and AI recap consume.
//
// Four signals computed:
//   1. Defensive composite: average rank of XLP/XLU/XLV/XLRE
//   2. XLY/XLP ratio: discretionary-vs-staples momentum
//   3. SPY trend overlay: above/below 50DMA & 200DMA + VIX level
//   4. Velocity divergence: sectors where 1w RS diverges from 1m RS

const DEFENSIVE_SECTORS = ['XLP', 'XLU', 'XLV', 'XLRE'];

// ---------------------------------------------------------------------------
// Math helpers (mirror the scanner — kept local so this module is portable)
// ---------------------------------------------------------------------------

function pctChange(bars, lookback) {
  if (!bars || bars.length < lookback + 1) return null;
  const now = bars[bars.length - 1].close;
  const then = bars[bars.length - 1 - lookback].close;
  if (!then) return null;
  return ((now - then) / then) * 100;
}

function sma(bars, n) {
  if (!bars || bars.length < n) return null;
  const slice = bars.slice(-n);
  const sum = slice.reduce((a, b) => a + b.close, 0);
  return sum / n;
}

function lastClose(bars) {
  if (!bars || bars.length === 0) return null;
  return bars[bars.length - 1].close;
}

function ratioSeries(numBars, denBars) {
  // Build a synthetic ratio series, aligned by index from the end backwards
  if (!numBars || !denBars) return null;
  const len = Math.min(numBars.length, denBars.length);
  const series = [];
  for (let i = 0; i < len; i++) {
    const ni = numBars[numBars.length - 1 - i];
    const di = denBars[denBars.length - 1 - i];
    if (!ni || !di || !di.close) continue;
    series.unshift({ date: ni.date, close: ni.close / di.close });
  }
  return series;
}

// ---------------------------------------------------------------------------
// Signal 1: Defensive composite
// ---------------------------------------------------------------------------

function defensiveComposite(rows) {
  // rows is sorted by composite RS desc. Build rank lookup.
  const rankByEtf = {};
  rows.forEach((r, i) => (rankByEtf[r.ticker] = i + 1));

  const ranks = DEFENSIVE_SECTORS
    .map((t) => rankByEtf[t])
    .filter((r) => typeof r === 'number');

  if (ranks.length === 0) return null;

  const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  // For an 11-sector universe, average rank of 6 is neutral.
  // ≤ 5.5 means defensives are skewing into the top half — risk-off tell.
  // ≤ 4 is a strong risk-off signal.
  let signal = 'NEUTRAL';
  if (avgRank <= 4) signal = 'STRONG RISK-OFF';
  else if (avgRank <= 5.5) signal = 'EMERGING RISK-OFF';
  else if (avgRank >= 8) signal = 'STRONG RISK-ON';

  return {
    avgRank: parseFloat(avgRank.toFixed(2)),
    ranks: DEFENSIVE_SECTORS.reduce((acc, t) => {
      acc[t] = rankByEtf[t] || null;
      return acc;
    }, {}),
    signal,
  };
}

// ---------------------------------------------------------------------------
// Signal 2: XLY / XLP ratio (consumer discretionary vs staples)
// ---------------------------------------------------------------------------

function xlyXlpRead(data) {
  if (!data.XLY || !data.XLP) return null;
  const ratio = ratioSeries(data.XLY, data.XLP);
  if (!ratio || ratio.length < 22) return null;

  const change1w = pctChange(ratio, 5);
  const change1m = pctChange(ratio, 21);
  const change3m = pctChange(ratio, 63);

  // Negative 1-month change = staples winning = caution flag
  let signal = 'NEUTRAL';
  if (change1m < 0 && change1w < 0) signal = 'CAUTION';
  else if (change1m < -1.5) signal = 'RISK-OFF CONFIRMED';
  else if (change1m > 0 && change1w > 0) signal = 'RISK-ON';

  return {
    change1w: parseFloat(change1w.toFixed(2)),
    change1m: parseFloat(change1m.toFixed(2)),
    change3m: change3m !== null ? parseFloat(change3m.toFixed(2)) : null,
    signal,
  };
}

// ---------------------------------------------------------------------------
// Signal 3: SPY trend overlay + VIX
// ---------------------------------------------------------------------------

function spyTrendRead(data) {
  if (!data.SPY) return null;
  const spy = data.SPY;
  const price = lastClose(spy);
  const ma50 = sma(spy, 50);
  const ma200 = sma(spy, 200);

  const above50 = ma50 !== null ? price > ma50 : null;
  const above200 = ma200 !== null ? price > ma200 : null;

  // VIX read if available
  let vixLevel = null;
  let vixSignal = null;
  if (data.VIX && data.VIX.length) {
    vixLevel = lastClose(data.VIX);
    if (vixLevel < 15) vixSignal = 'COMPLACENT';
    else if (vixLevel < 20) vixSignal = 'CALM';
    else if (vixLevel < 25) vixSignal = 'ELEVATED';
    else if (vixLevel < 30) vixSignal = 'FEAR';
    else vixSignal = 'PANIC';
  }

  // Trend classification
  let trend = 'UNKNOWN';
  if (above50 === true && above200 === true) trend = 'UPTREND';
  else if (above50 === false && above200 === false) trend = 'DOWNTREND';
  else if (above50 === false && above200 === true) trend = 'CORRECTION';
  else if (above50 === true && above200 === false) trend = 'RECOVERY';

  return {
    price: parseFloat(price.toFixed(2)),
    ma50: ma50 !== null ? parseFloat(ma50.toFixed(2)) : null,
    ma200: ma200 !== null ? parseFloat(ma200.toFixed(2)) : null,
    pctFromMa50: ma50 !== null ? parseFloat((((price - ma50) / ma50) * 100).toFixed(2)) : null,
    pctFromMa200: ma200 !== null ? parseFloat((((price - ma200) / ma200) * 100).toFixed(2)) : null,
    trend,
    vixLevel: vixLevel !== null ? parseFloat(vixLevel.toFixed(2)) : null,
    vixSignal,
  };
}

// ---------------------------------------------------------------------------
// Signal 4: Velocity divergence — 1w vs 1m RS divergence
// ---------------------------------------------------------------------------

function velocityDivergence(rows) {
  // Flag sectors where short-term momentum has clearly broken from the medium-term trend.
  // Specifically: |1w - (1m/4.2)| > 2pp AND signs are opposite, OR
  //               1w deeply negative while 1m still positive (or vice versa)
  const flags = [];
  for (const r of rows) {
    // Normalize 1m to a weekly-equivalent rate (21 trading days / 5 ≈ 4.2)
    const weeklyEquivalent = r.mo / 4.2;
    const divergence = r.wk - weeklyEquivalent;

    // Conditions that matter:
    // 1. Recent week deeply negative while 1m still positive (early breakdown)
    // 2. Recent week strongly positive while 1m negative (early recovery)
    if (r.wk < -1.5 && r.mo > 0 && divergence < -2) {
      flags.push({
        ticker: r.ticker,
        type: 'BREAKDOWN',
        wk: r.wk,
        mo: r.mo,
        divergence: parseFloat(divergence.toFixed(2)),
      });
    } else if (r.wk > 1.5 && r.mo < 0 && divergence > 2) {
      flags.push({
        ticker: r.ticker,
        type: 'RECOVERY',
        wk: r.wk,
        mo: r.mo,
        divergence: parseFloat(divergence.toFixed(2)),
      });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Master read — combines all four into an overall risk verdict
// ---------------------------------------------------------------------------

function masterRiskVerdict(parts) {
  const { defensive, xlyXlp, spyTrend, velocity } = parts;
  let score = 0; // higher = more risk-off
  const reasons = [];

  if (defensive?.signal === 'STRONG RISK-OFF') {
    score += 3;
    reasons.push(`Defensives dominating (avg rank ${defensive.avgRank})`);
  } else if (defensive?.signal === 'EMERGING RISK-OFF') {
    score += 2;
    reasons.push(`Defensives emerging (avg rank ${defensive.avgRank})`);
  } else if (defensive?.signal === 'STRONG RISK-ON') {
    score -= 2;
    reasons.push('Defensives at bottom of rankings');
  }

  if (xlyXlp?.signal === 'RISK-OFF CONFIRMED') {
    score += 3;
    reasons.push(`XLY/XLP rolling over (1m ${xlyXlp.change1m}%)`);
  } else if (xlyXlp?.signal === 'CAUTION') {
    score += 2;
    reasons.push('XLY/XLP weakening — consumer caution');
  } else if (xlyXlp?.signal === 'RISK-ON') {
    score -= 1;
  }

  if (spyTrend?.trend === 'DOWNTREND') {
    score += 3;
    reasons.push('SPY below 50DMA and 200DMA');
  } else if (spyTrend?.trend === 'CORRECTION') {
    score += 2;
    reasons.push('SPY below 50DMA, holding 200DMA');
  } else if (spyTrend?.trend === 'UPTREND') {
    score -= 1;
  }

  if (spyTrend?.vixSignal === 'PANIC') {
    score += 3;
    reasons.push(`VIX in panic territory (${spyTrend.vixLevel})`);
  } else if (spyTrend?.vixSignal === 'FEAR') {
    score += 2;
    reasons.push(`VIX elevated (${spyTrend.vixLevel})`);
  } else if (spyTrend?.vixSignal === 'ELEVATED') {
    score += 1;
  }

  // Velocity breakdowns add weight
  const breakdowns = velocity.filter((v) => v.type === 'BREAKDOWN');
  if (breakdowns.length >= 3) {
    score += 2;
    reasons.push(`${breakdowns.length} sectors showing breakdown velocity`);
  } else if (breakdowns.length >= 1) {
    score += 1;
  }

  // Classify
  let verdict = 'NEUTRAL';
  if (score >= 7) verdict = 'TAKE RISK OFF';
  else if (score >= 4) verdict = 'CAUTION';
  else if (score <= -2) verdict = 'RISK-ON CONFIRMED';

  return { verdict, score, reasons };
}

// ---------------------------------------------------------------------------
// Top-level — builds the full risk regime payload
// ---------------------------------------------------------------------------

function buildRiskRegime(rows, data) {
  const defensive = defensiveComposite(rows);
  const xlyXlp = xlyXlpRead(data);
  const spyTrend = spyTrendRead(data);
  const velocity = velocityDivergence(rows);

  const verdict = masterRiskVerdict({ defensive, xlyXlp, spyTrend, velocity });

  return {
    defensive,
    xlyXlp,
    spyTrend,
    velocity,
    verdict,
  };
}

module.exports = { buildRiskRegime, DEFENSIVE_SECTORS };
