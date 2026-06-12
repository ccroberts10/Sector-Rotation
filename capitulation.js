// capitulation.js
// Detects when markets are washed out and bounce-prone. Complementary to
// riskRegime (which catches risk-off). Uses four reliable signals:
//
//   1. VIX level — fear gauge from FRED
//   2. VIX/VXV ratio — term-structure fear gauge (replaces unreliable Put/Call)
//   3. Sector breadth — % of 11 SPDR sector ETFs below their own 20DMA
//   4. ABV pressure — 10-day SMA of up-volume/down-volume across sector ETFs
//      (homegrown analog to Worden's T2101 ABI indicator)
//
// All four computed from data the main scanner already fetches. No new APIs.
// Composite "capitulation score" with verdict thresholds:
//   score >= 7 = BOUNCE SETUP (high-conviction bounce zone)
//   score >= 4 = OVERSOLD (multiple signals firing, watch closely)
//   score >= 2 = WATCH (early warning)

function lastClose(bars) {
  if (!bars || bars.length === 0) return null;
  return bars[bars.length - 1].close;
}

function sma(bars, n) {
  if (!bars || bars.length < n) return null;
  const slice = bars.slice(-n);
  const sum = slice.reduce((a, b) => a + b.close, 0);
  return sum / n;
}

// ---------------------------------------------------------------------------
// Signal 1: VIX
// ---------------------------------------------------------------------------
// Standalone VIX extremes act as capitulation signals:
//   < 15  = complacency
//   15-20 = calm
//   20-25 = elevated
//   25-30 = fear
//   30+   = panic / capitulation territory
//   35+   = historic washout

function vixRead(bars) {
  if (!bars || bars.length === 0) return null;
  const value = lastClose(bars);
  if (value === null) return null;

  const avg5 = bars.length >= 5
    ? bars.slice(-5).reduce((a, b) => a + b.close, 0) / 5
    : null;

  let signal = 'CALM';
  let fires = false;
  if (value >= 35) {
    signal = 'HISTORIC WASHOUT';
    fires = true;
  } else if (value >= 30) {
    signal = 'PANIC';
    fires = true;
  } else if (value >= 25) {
    signal = 'FEAR';
    fires = true;
  } else if (value >= 20) {
    signal = 'ELEVATED';
  } else if (value < 15) {
    signal = 'COMPLACENCY';
  }

  return {
    value: parseFloat(value.toFixed(2)),
    avg5: avg5 !== null ? parseFloat(avg5.toFixed(2)) : null,
    signal,
    fires,
  };
}

// ---------------------------------------------------------------------------
// Signal 2: VIX / VXV ratio (term-structure fear gauge)
// ---------------------------------------------------------------------------
// Replaces the unreliable CBOE Put/Call ratio with a more robust fear signal.
// VIX is 30-day implied vol; VXV is 3-month implied vol. The ratio:
//   < 0.85 = complacency (near-term vol cheap vs longer-term)
//   0.85-0.95 = normal contango
//   > 1.00 = inverted — near-term fear pricing higher than 3-month, contrarian bullish
//   > 1.10 = strong fear, historic bounce zone
//   > 1.20 = extreme inversion, panic
// Mathematically different from CPC but captures the same psychology.

function cpcRead(bars) {
  if (!bars || bars.length === 0) return null;
  const value = lastClose(bars);
  if (value === null) return null;

  const avg5 = bars.length >= 5
    ? bars.slice(-5).reduce((a, b) => a + b.close, 0) / 5
    : null;

  let signal = 'NORMAL';
  let fires = false;
  if (value > 1.20) {
    signal = 'PANIC';
    fires = true;
  } else if (value > 1.10) {
    signal = 'STRONG FEAR';
    fires = true;
  } else if (value > 1.00) {
    signal = 'INVERTED';
    fires = true;
  } else if (value < 0.85) {
    signal = 'COMPLACENCY';
  }

  return {
    value: parseFloat(value.toFixed(3)),
    avg5: avg5 !== null ? parseFloat(avg5.toFixed(3)) : null,
    signal,
    fires,
  };
}

// ---------------------------------------------------------------------------
// Signal 3: Sector Breadth — computed from data already fetched
// ---------------------------------------------------------------------------
// Counts how many of the 11 SPDR sector ETFs are below their own 20DMA.
// When the broad market is selling off, most/all sectors break their 20DMA
// simultaneously. Functionally similar to NYMO (NYSE breadth deteriorating)
// but uses sector-level data we already have. Arguably MORE relevant than
// NYMO for a sector-rotation-driven trading approach.
//
//   <= 3/11 below = strong breadth, complacent
//    4-6/11      = neutral
//    7-8/11      = weak breadth (early warning)
//    9-10/11     = oversold (bounce-prone)
//      11/11     = full washout

function sectorBreadthRead(sectorData, sectorTickers) {
  if (!sectorData || !sectorTickers || sectorTickers.length === 0) return null;

  let below = 0;
  let above = 0;
  const tickersBelow = [];
  const tickersAbove = [];

  for (const ticker of sectorTickers) {
    const bars = sectorData[ticker];
    if (!bars || bars.length < 20) continue;

    const price = lastClose(bars);
    const ma20 = sma(bars, 20);
    if (price === null || ma20 === null) continue;

    if (price < ma20) {
      below++;
      tickersBelow.push(ticker);
    } else {
      above++;
      tickersAbove.push(ticker);
    }
  }

  const total = below + above;
  if (total === 0) return null;

  const pctBelow = (below / total) * 100;

  let signal = 'NEUTRAL';
  let fires = false;
  if (below === total && total >= 10) {
    signal = 'FULL WASHOUT';
    fires = true;
  } else if (below >= 9) {
    signal = 'OVERSOLD';
    fires = true;
  } else if (below >= 7) {
    signal = 'WEAK BREADTH';
  } else if (below <= 3) {
    signal = 'STRONG BREADTH';
  }

  return {
    below,
    above,
    total,
    pctBelow: parseFloat(pctBelow.toFixed(1)),
    tickersBelow,
    tickersAbove,
    signal,
    fires,
  };
}

// ---------------------------------------------------------------------------
// Signal 4: ABV Pressure (Advance-Decline Volume, ABI-equivalent)
// ---------------------------------------------------------------------------
// Functional equivalent of Worden's T2101 ABI built from data we already
// fetch. The original ABI is a 10-day SMA of NYSE up-volume / down-volume,
// signaling exhaustion when it drops below ~13. We do the same thing on the
// SPDR sector ETF universe + SPY:
//
//   For each day in the lookback window:
//     - Each ETF with close > prior close contributes its volume to "up"
//     - Each ETF with close < prior close contributes its volume to "down"
//     - Daily ratio = up_volume / down_volume
//   Smooth with a 10-day SMA, compare to thresholds.
//
// Different absolute scale than ABI because the universe is smaller, but
// captures the same mechanism — sustained down-volume dominance = exhaustion.
//
// Thresholds (10-day SMA of ratio):
//   < 0.40 = washout (extreme — analog to ABI < 11)
//   < 0.55 = signal firing (analog to ABI < 13)
//   < 0.75 = weak pressure (early warning)
//    >2.5 = strong buying pressure (potential overheating)

function abvPressureRead(data, tickers, smaWindow = 10) {
  if (!data || !tickers || tickers.length === 0) return null;

  // Build per-ETF aligned series with prior-close marker
  // Index data by date for fast cross-ETF alignment
  const allDates = new Set();
  const byTicker = {};

  for (const t of tickers) {
    const bars = data[t];
    if (!bars || bars.length < 2) continue;
    byTicker[t] = {};
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      const prev = bars[i - 1];
      if (!b.volume || !prev || !prev.close) continue;
      const change = b.close - prev.close;
      byTicker[t][b.date] = { volume: b.volume, change };
      allDates.add(b.date);
    }
  }

  // Sort dates ascending
  const sortedDates = Array.from(allDates).sort();
  if (sortedDates.length < smaWindow + 1) return null;

  // For each date, compute up/down volume across the universe
  const dailyRatios = [];
  for (const date of sortedDates) {
    let upVol = 0;
    let downVol = 0;
    for (const t of tickers) {
      const day = byTicker[t]?.[date];
      if (!day) continue;
      if (day.change > 0) upVol += day.volume;
      else if (day.change < 0) downVol += day.volume;
      // flat days don't contribute
    }
    if (downVol > 0) {
      dailyRatios.push({ date, ratio: upVol / downVol });
    } else if (upVol > 0) {
      // All-up day, no down-volume — cap ratio at a high value to avoid Infinity
      dailyRatios.push({ date, ratio: 10 });
    }
  }

  if (dailyRatios.length < smaWindow) return null;

  // 10-day SMA of the ratios
  const recent = dailyRatios.slice(-smaWindow);
  const sma10 = recent.reduce((sum, r) => sum + r.ratio, 0) / smaWindow;

  // Also grab the latest daily ratio for context
  const latestDaily = dailyRatios[dailyRatios.length - 1].ratio;

  // Classification
  let signal = 'NEUTRAL';
  let fires = false;
  if (sma10 < 0.40) {
    signal = 'WASHOUT';
    fires = true;
  } else if (sma10 < 0.55) {
    signal = 'EXHAUSTED SELLING';
    fires = true;
  } else if (sma10 < 0.75) {
    signal = 'WEAK PRESSURE';
  } else if (sma10 > 2.5) {
    signal = 'STRONG BUYING';
  }

  return {
    sma10: parseFloat(sma10.toFixed(3)),
    latestDaily: parseFloat(latestDaily.toFixed(3)),
    windowDays: smaWindow,
    universe: tickers.length,
    signal,
    fires,
  };
}

// ---------------------------------------------------------------------------
// Master verdict
// ---------------------------------------------------------------------------

function capitulationVerdict(parts) {
  const { vix, cpc, breadth, abv } = parts;
  const firing = [];
  let score = 0;
  const reasons = [];

  if (vix?.fires) {
    firing.push('VIX');
    if (vix.signal === 'HISTORIC WASHOUT') {
      score += 3;
      reasons.push(`VIX ${vix.value} — historic washout`);
    } else if (vix.signal === 'PANIC') {
      score += 3;
      reasons.push(`VIX ${vix.value} — panic`);
    } else if (vix.signal === 'FEAR') {
      score += 2;
      reasons.push(`VIX ${vix.value} — fear`);
    }
  }

  if (cpc?.fires) {
    firing.push('VIX/VXV');
    if (cpc.signal === 'PANIC') {
      score += 3;
      reasons.push(`VIX/VXV ${cpc.value} — panic inversion`);
    } else if (cpc.signal === 'STRONG FEAR') {
      score += 2;
      reasons.push(`VIX/VXV ${cpc.value} — strong fear`);
    } else {
      score += 1;
      reasons.push(`VIX/VXV ${cpc.value} — term structure inverted`);
    }
  }

  if (breadth?.fires) {
    firing.push('BREADTH');
    if (breadth.signal === 'FULL WASHOUT') {
      score += 3;
      reasons.push(`All ${breadth.total} sectors below 20DMA — full washout`);
    } else {
      score += 2;
      reasons.push(`${breadth.below}/${breadth.total} sectors below 20DMA — oversold`);
    }
  }

  if (abv?.fires) {
    firing.push('ABV');
    if (abv.signal === 'WASHOUT') {
      score += 3;
      reasons.push(`ABV 10d ${abv.sma10} — volume washout`);
    } else if (abv.signal === 'EXHAUSTED SELLING') {
      score += 2;
      reasons.push(`ABV 10d ${abv.sma10} — exhausted selling`);
    }
  }

  // Verdict thresholds — recalibrated for 4 signals max
  // Max possible score with all four firing extreme: 3+3+3+3 = 12
  let verdict = 'NEUTRAL';
  if (score >= 7) verdict = 'BOUNCE SETUP';
  else if (score >= 4) verdict = 'OVERSOLD';
  else if (score >= 2) verdict = 'WATCH';

  return { verdict, score, firing, reasons };
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

function buildCapitulation(data, sectorTickers) {
  const vix = vixRead(data.VIX);
  const cpc = cpcRead(data.CPC);
  const breadth = sectorBreadthRead(data, sectorTickers);
  // ABV runs on sector ETFs + SPY for broader volume coverage
  const abvTickers = sectorTickers.includes('SPY') ? sectorTickers : ['SPY', ...sectorTickers];
  const abv = abvPressureRead(data, abvTickers);
  const verdict = capitulationVerdict({ vix, cpc, breadth, abv });

  return {
    vix,
    cpc,
    breadth,
    abv,
    verdict,
  };
}

module.exports = { buildCapitulation };
