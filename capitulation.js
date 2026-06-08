// capitulation.js
// Layer of "is the market washed out and ready to bounce" detection.
// Complementary to riskRegime — that one tells you when to take risk OFF,
// this one tells you when oversold conditions suggest putting risk back ON.
//
// Three signals, all free via Yahoo Finance:
//   1. McClellan Oscillator (^NYMO): NYSE breadth oscillator
//   2. TRIN / Arms Index (^TRIN): up/down volume ratio
//   3. Put/Call Ratio (^CPC): CBOE total put/call
//
// Composite "capitulation score" fires when 2 of 3 are in extreme territory.

const CAPITULATION_TICKERS = ['^NYMO', '^TRIN', '^CPC'];

function lastClose(bars) {
  if (!bars || bars.length === 0) return null;
  return bars[bars.length - 1].close;
}

function pctChange(bars, lookback) {
  if (!bars || bars.length < lookback + 1) return null;
  const now = bars[bars.length - 1].close;
  const then = bars[bars.length - 1 - lookback].close;
  if (!then) return null;
  return ((now - then) / then) * 100;
}

// ---------------------------------------------------------------------------
// Signal 1: McClellan Oscillator (NYMO)
// ---------------------------------------------------------------------------
// Range typically -150 to +150. Negative = breadth deteriorating.
//   > +70  = overbought (counterintuitively often precedes pullbacks)
//   < -70  = oversold, bounce-prone
//   < -100 = extreme oversold, capitulation territory
//   < -130 = panic / historic washout

function nymoRead(bars) {
  if (!bars || bars.length === 0) return null;
  const value = lastClose(bars);
  if (value === null) return null;

  let signal = 'NEUTRAL';
  let fires = false;
  if (value < -130) {
    signal = 'PANIC WASHOUT';
    fires = true;
  } else if (value < -100) {
    signal = 'EXTREME OVERSOLD';
    fires = true;
  } else if (value < -70) {
    signal = 'OVERSOLD';
    fires = true;
  } else if (value > 70) {
    signal = 'OVERBOUGHT';
  } else if (value > 30) {
    signal = 'STRONG BREADTH';
  }

  return {
    value: parseFloat(value.toFixed(2)),
    signal,
    fires,
  };
}

// ---------------------------------------------------------------------------
// Signal 2: TRIN (Arms Index)
// ---------------------------------------------------------------------------
// TRIN = (advancing issues / declining issues) / (advancing volume / declining volume)
//   < 0.5  = strong buying
//   0.8-1.2 = neutral
//   > 1.5  = elevated selling
//   > 2.0  = capitulation
//   > 3.0  = panic selling
// NB: A high TRIN intraday but with strong rally suggests strong stocks getting bought
// hard — for daily close interpretation, > 2.0 = washout signal.

function trinRead(bars) {
  if (!bars || bars.length === 0) return null;
  const value = lastClose(bars);
  if (value === null) return null;

  let signal = 'NEUTRAL';
  let fires = false;
  if (value > 3.0) {
    signal = 'PANIC SELLING';
    fires = true;
  } else if (value > 2.0) {
    signal = 'CAPITULATION';
    fires = true;
  } else if (value > 1.5) {
    signal = 'ELEVATED SELLING';
  } else if (value < 0.5) {
    signal = 'STRONG BUYING';
  }

  return {
    value: parseFloat(value.toFixed(2)),
    signal,
    fires,
  };
}

// ---------------------------------------------------------------------------
// Signal 3: CBOE Put/Call Ratio (CPC)
// ---------------------------------------------------------------------------
// Total put/call ratio across CBOE.
//   < 0.7  = complacency
//   0.7-0.9 = normal
//   > 1.0  = elevated fear, contrarian bullish
//   > 1.2  = extreme fear, strong contrarian signal
//   > 1.4  = panic, historic bounce zone

function cpcRead(bars) {
  if (!bars || bars.length === 0) return null;
  const value = lastClose(bars);
  if (value === null) return null;

  // 5-day average smooths out daily noise — useful confirmation
  let avg5 = null;
  if (bars.length >= 5) {
    const recent = bars.slice(-5);
    avg5 = recent.reduce((a, b) => a + b.close, 0) / 5;
  }

  let signal = 'NEUTRAL';
  let fires = false;
  if (value > 1.4) {
    signal = 'PANIC';
    fires = true;
  } else if (value > 1.2) {
    signal = 'EXTREME FEAR';
    fires = true;
  } else if (value > 1.0) {
    signal = 'ELEVATED FEAR';
    fires = true;
  } else if (value < 0.7) {
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
// Master capitulation verdict
// ---------------------------------------------------------------------------

function capitulationVerdict(parts) {
  const { nymo, trin, cpc } = parts;
  const firing = [];
  let score = 0;
  const reasons = [];

  if (nymo?.fires) {
    firing.push('NYMO');
    if (nymo.signal === 'PANIC WASHOUT') {
      score += 3;
      reasons.push(`NYMO ${nymo.value} — historic washout`);
    } else if (nymo.signal === 'EXTREME OVERSOLD') {
      score += 2;
      reasons.push(`NYMO ${nymo.value} — extreme oversold`);
    } else {
      score += 1;
      reasons.push(`NYMO ${nymo.value} — oversold`);
    }
  }

  if (trin?.fires) {
    firing.push('TRIN');
    if (trin.signal === 'PANIC SELLING') {
      score += 3;
      reasons.push(`TRIN ${trin.value} — panic selling`);
    } else if (trin.signal === 'CAPITULATION') {
      score += 2;
      reasons.push(`TRIN ${trin.value} — capitulation`);
    }
  }

  if (cpc?.fires) {
    firing.push('CPC');
    if (cpc.signal === 'PANIC') {
      score += 3;
      reasons.push(`P/C ${cpc.value} — panic`);
    } else if (cpc.signal === 'EXTREME FEAR') {
      score += 2;
      reasons.push(`P/C ${cpc.value} — extreme fear`);
    } else {
      score += 1;
      reasons.push(`P/C ${cpc.value} — elevated fear`);
    }
  }

  // Verdict thresholds:
  //   score >= 6 = high-conviction bounce setup (2+ extreme signals or 3 elevated)
  //   score >= 4 = bounce-prone, multiple signals firing
  //   score >= 2 = early warning of oversold conditions
  let verdict = 'NEUTRAL';
  if (score >= 6) verdict = 'BOUNCE SETUP';
  else if (score >= 4) verdict = 'OVERSOLD';
  else if (score >= 2) verdict = 'WATCH';

  return {
    verdict,
    score,
    firing,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

function buildCapitulation(data) {
  const nymo = nymoRead(data.NYMO);
  const trin = trinRead(data.TRIN);
  const cpc = cpcRead(data.CPC);
  const verdict = capitulationVerdict({ nymo, trin, cpc });

  return {
    nymo,
    trin,
    cpc,
    verdict,
  };
}

module.exports = { buildCapitulation, CAPITULATION_TICKERS };
