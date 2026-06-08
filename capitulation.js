// capitulation.js
// Detects when markets are washed out and bounce-prone. Complementary to
// riskRegime (which catches risk-off). Uses three reliable signals:
//
//   1. VIX level — fear gauge, already fetched in main scanner
//   2. CBOE Put/Call ratio — fetched direct from CBOE daily CSV
//   3. Sector breadth — % of the 11 SPDR sector ETFs below their own 20DMA
//      (computed from data already fetched by main scanner — no extra calls)
//
// Composite "capitulation score" fires when 2 of 3 are in extreme territory.

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
// Master verdict
// ---------------------------------------------------------------------------

function capitulationVerdict(parts) {
  const { vix, cpc, breadth } = parts;
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

  let verdict = 'NEUTRAL';
  if (score >= 6) verdict = 'BOUNCE SETUP';
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
  const verdict = capitulationVerdict({ vix, cpc, breadth });

  return {
    vix,
    cpc,
    breadth,
    verdict,
  };
}

module.exports = { buildCapitulation };
