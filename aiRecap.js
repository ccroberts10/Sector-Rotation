// aiRecap.js
// Generates a 2-3 sentence plain-English recap of the day's sector rotation
// findings using Claude. Returns an empty string if ANTHROPIC_API_KEY is not
// set so the scanner still works without it.

const https = require('https');

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 500;

function anthropicCall(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return resolve(null);

    const body = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });

    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(chunks);
          const text = parsed?.content?.[0]?.text;
          resolve(text || null);
        } catch (e) {
          reject(new Error(`AI recap parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Generate a recap from the day's sector data.
 * @param {object} ctx - { rows, biotechSignal, shifts, regime }
 * @returns {Promise<string>} 2-3 sentence recap, or '' if API not configured
 */
async function generateRecap(ctx) {
  const { rows, biotechSignal, shifts, regime, riskRegime, capitulation } = ctx;

  // Compact data for the prompt
  const ranking = rows
    .map((r, i) => `${i + 1}. ${r.ticker} (comp ${r.composite.toFixed(1)}, 1w ${r.wk.toFixed(1)}%, 1m ${r.mo.toFixed(1)}%)`)
    .join('\n');

  const shiftText = shifts.length
    ? shifts.map((s) => `${s.dir} ${s.ticker}: #${s.old}->#${s.new}`).join(', ')
    : 'none';

  // Build risk regime context block
  let riskBlock = '';
  if (riskRegime) {
    const lines = [`Risk verdict: ${riskRegime.verdict.verdict} (score ${riskRegime.verdict.score})`];
    if (riskRegime.defensive) {
      lines.push(`Defensives avg rank: ${riskRegime.defensive.avgRank} (${riskRegime.defensive.signal})`);
    }
    if (riskRegime.xlyXlp) {
      lines.push(`XLY/XLP momentum (1m): ${riskRegime.xlyXlp.change1m}% (${riskRegime.xlyXlp.signal})`);
    }
    if (riskRegime.spyTrend) {
      const s = riskRegime.spyTrend;
      lines.push(`SPY trend: ${s.trend}, ${s.pctFromMa50}% from 50DMA, ${s.pctFromMa200}% from 200DMA`);
      if (s.vixLevel !== null) {
        lines.push(`VIX: ${s.vixLevel} (${s.vixSignal})`);
      }
    }
    if (riskRegime.velocity && riskRegime.velocity.length) {
      lines.push(`Velocity flags: ${riskRegime.velocity.map((v) => `${v.ticker} ${v.type}`).join(', ')}`);
    }
    if (riskRegime.verdict.reasons.length) {
      lines.push(`Reasons: ${riskRegime.verdict.reasons.join('; ')}`);
    }
    riskBlock = '\nRisk regime overlay:\n' + lines.join('\n') + '\n';
  }

  // Build capitulation context block
  let capBlock = '';
  if (capitulation) {
    const lines = [`Capitulation verdict: ${capitulation.verdict.verdict} (score ${capitulation.verdict.score})`];
    if (capitulation.nymo) {
      lines.push(`McClellan Oscillator (NYMO): ${capitulation.nymo.value} (${capitulation.nymo.signal})`);
    }
    if (capitulation.trin) {
      lines.push(`TRIN: ${capitulation.trin.value} (${capitulation.trin.signal})`);
    }
    if (capitulation.cpc) {
      lines.push(`Put/Call ratio: ${capitulation.cpc.value} (${capitulation.cpc.signal})`);
    }
    if (capitulation.verdict.reasons.length) {
      lines.push(`Firing: ${capitulation.verdict.reasons.join('; ')}`);
    }
    capBlock = '\nCapitulation watch (oversold/bounce signals):\n' + lines.join('\n') + '\n';
  }

  const prompt = `You are an experienced market strategist writing a brief end-of-day note for an active trader running a tech/semis-heavy momentum book.

Today's sector rotation data:
Regime: ${regime}
Sector rankings (composite RS vs SPY):
${ranking}

Biotech read: ${biotechSignal}
Rank shifts vs prior run: ${shiftText}
${riskBlock}${capBlock}
Write a tight 3-4 sentence recap in plain, direct prose. Target 90-130 words total — be ruthless about brevity. No bullet points, no preamble, no "in summary." Focus on:
1. The most important verdict right now — is the regime risk-off, oversold/bounce-prone, or neither?
2. The single most actionable takeaway given ALL the data (sector ranks, risk regime, capitulation watch)
3. One specific thing to watch tomorrow that would confirm or contradict the current read

Be specific. Reference actual tickers and concrete numbers. Trader-to-trader tone, not corporate. Finish your thought — do not get cut off mid-sentence.

Priority rules:
- If capitulation verdict is BOUNCE SETUP, that's the headline — lead with it (oversold conditions argue for putting risk back ON, even if risk regime is risk-off)
- If risk regime is TAKE RISK OFF AND capitulation is NEUTRAL, lead with the risk-off warning
- If both fire at once (rare but powerful), call out the resolution — a TAKE RISK OFF + BOUNCE SETUP combo often marks the bottom
- Otherwise, lead with whichever signal is strongest`;

  try {
    const recap = await anthropicCall(prompt);
    if (!recap) return '';
    return recap.trim();
  } catch (e) {
    console.warn('AI recap failed:', e.message);
    return '';
  }
}

module.exports = { generateRecap };
