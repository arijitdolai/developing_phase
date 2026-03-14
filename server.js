/*
  =====================================================
  PASSIVE HUMAN VERIFICATION — server.js
  Net Score System: 0 start, +100 = Bot, -100 = Human

  KEY RULE: If no data detected for a parameter in
  the 3-second window → contribution = 0 (neutral).
  Parameters only score when they have actual data.
  =====================================================
*/

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = 8000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'PHVS Backend running ✅' });
});

// =====================================================
// SCORING TABLES — raw points (-100 to +100)
// Positive = bot evidence, Negative = human evidence
// =====================================================

// ③ Click Duration — Weight 0.20
function scoreClickDuration(ms) {
  if (ms < 5)   return 100;
  if (ms < 10)  return 70;
  if (ms < 20)  return 50;
  if (ms < 75)  return 0;
  if (ms < 100) return -50;
  return -100;
}

// ④ Button Heatmap — Weight 0.15
function scoreButtonHeatmap(s) {
  const map = {100:100, 90:30, 80:0, 70:0, 60:-10, 50:-15, 40:-20, 30:-25, 20:0, 10:0};
  return map[s] !== undefined ? map[s] : 0;
}

// ⑤ Backspace — Weight 0.10
function scoreBackspace(n) {
  if (n === 1) return -50;
  if (n === 2) return -60;
  if (n === 3) return -80;
  if (n >= 6)  return -100;
  return -80;   // 4–5
}

// ⑥ Trajectory Deviation — Weight 0.10
function scoreDeviation(p) {
  if (p < 1)   return 100;
  if (p < 2)   return 50;
  if (p < 5)   return 20;
  if (p < 10)  return 0;
  if (p < 20)  return 20;
  if (p < 40)  return -50;
  if (p < 80)  return -80;
  return -100;
}

// ⑦ Velocity CV — Weight 0.15
function scoreVelocityCV(p) {
  if (p < 5)   return 100;
  if (p < 10)  return 50;
  if (p < 20)  return 20;
  if (p < 50)  return 0;
  if (p < 70)  return -20;
  if (p < 100) return -50;
  return -100;
}

// ⑧a Dwell Speed — Weight 0.075
function scoreDwellSpeed(ms) {
  if (ms > 350) return null;   // above 350ms not considered
  if (ms < 10)  return 100;
  if (ms < 50)  return 50;
  if (ms < 80)  return 0;
  if (ms < 100) return -30;
  if (ms < 250) return -50;
  return -100;
}

// ⑧b Dwell CV — Weight 0.10
function scoreDwellCV(p) {
  if (p > 100) return null;   // irregular — not considered
  if (p < 2)   return 100;
  if (p < 5)   return 50;
  if (p < 10)  return 40;
  if (p < 15)  return 20;
  if (p < 35)  return 0;
  if (p < 50)  return -50;
  return -70;
}

// ⑨ Focus Events — Weight 0.05
function scoreFocus(n) {
  if (n === 0)  return 100;
  if (n <= 2)   return 50;
  if (n <= 5)   return 0;
  if (n <= 10)  return -50;
  return -100;
}

// =====================================================
// VERIFY ROUTE
// =====================================================
app.post('/verify', (req, res) => {
  const {
    window: win   = 1,
    clicks        = [],
    btn_scores    = [],
    keystrokes    = [],
    backspaces    = [],
    focus         = [],
    honeypot      = false,
    honeypot_log  = {},
    deviation_pct = null,   // null if path < 250px
    velocity_cv   = null,   // null if path < 100px
    net_score     = 0
  } = req.body;

  console.log('\n══════════════════════════════════════');
  console.log(`📦 Window #${win} | Net score in: ${net_score}`);

  // ── TIER 1: Kill Switch ──
  if (honeypot) {
    const traps = Object.entries(honeypot_log)
      .filter(([,v]) => v && v.triggered).map(([k]) => k).join(', ');
    console.log(`🚨 KILL SWITCH: Honeypot [${traps}]`);
    return res.json({ kill_switch: true, delta: 0, breakdown: {} });
  }

  const breakdown = {};
  let delta = 0;

  // Helper — apply contribution only if data exists
  const apply = (name, raw, weight) => {
    if (raw === null || raw === undefined) {
      breakdown[name] = { raw: null, contribution: 0, reason: 'no data this window' };
      return;
    }
    const c = raw * weight;
    breakdown[name] = { raw, weight, contribution: +c.toFixed(3) };
    delta += c;
    console.log(`   ${name.padEnd(18)} raw:${String(raw).padStart(5)}  ×${weight}  = ${c.toFixed(3)}`);
  };

  // ③ Click Duration — only if clicks happened this window
  if (clicks.length > 0) {
    const avg = clicks.reduce((s,c) => s + c.duration, 0) / clicks.length;
    apply('click_duration', scoreClickDuration(avg), 0.20);
  } else {
    breakdown.click_duration = { raw: null, contribution: 0, reason: 'no clicks this window' };
    console.log(`   click_duration       — no clicks`);
  }

  // ④ Button Heatmap — only if button was clicked this window
  if (btn_scores.length > 0) {
    const avg = btn_scores.reduce((s,b) => s + b.score, 0) / btn_scores.length;
    apply('button_heatmap', scoreButtonHeatmap(Math.round(avg)), 0.15);
  } else {
    breakdown.button_heatmap = { raw: null, contribution: 0, reason: 'no btn clicks this window' };
    console.log(`   button_heatmap       — no button clicks`);
  }

  // ⑤ Backspace — only if backspace was pressed this window
  if (backspaces.length > 0) {
    apply('backspace', scoreBackspace(backspaces.length), 0.10);
  } else {
    breakdown.backspace = { raw: null, contribution: 0, reason: 'no backspaces this window' };
    console.log(`   backspace            — no backspaces`);
  }

  // ⑥ Trajectory Deviation — only if path >= 250px (deviation_pct not null)
  if (deviation_pct !== null) {
    apply('trajectory_dev', scoreDeviation(deviation_pct), 0.10);
  } else {
    breakdown.trajectory_dev = { raw: null, contribution: 0, reason: 'path < 250px or no movement' };
    console.log(`   trajectory_dev       — path too short or no movement`);
  }

  // ⑦ Velocity CV — only if path >= 100px (velocity_cv not null)
  if (velocity_cv !== null) {
    apply('velocity_cv', scoreVelocityCV(velocity_cv), 0.15);
  } else {
    breakdown.velocity_cv = { raw: null, contribution: 0, reason: 'path < 250px or no movement' };
    console.log(`   velocity_cv          — path too short or no movement`);
  }

  // ⑧ Dwelling — only if keystrokes happened this window
  const dwells = keystrokes.map(k => k.dwell).filter(d => d !== undefined);
  if (dwells.length > 0) {
    // ⑧a Dwell Speed
    const lastDwell = dwells[dwells.length - 1];
    apply('dwell_speed', scoreDwellSpeed(lastDwell), 0.075);

    // ⑧b Dwell CV — needs 3+ keystrokes
    if (dwells.length >= 3) {
      const avg = dwells.reduce((a,b) => a+b, 0) / dwells.length;
      const std = Math.sqrt(dwells.reduce((s,d) => s + Math.pow(d-avg,2), 0) / dwells.length);
      const cv  = avg > 0 ? Math.round((std/avg)*100) : 0;
      apply('dwell_cv', scoreDwellCV(cv), 0.10);
    } else {
      breakdown.dwell_cv = { raw: null, contribution: 0, reason: 'need 3+ keystrokes' };
      console.log(`   dwell_cv             — need 3+ keystrokes`);
    }
  } else {
    breakdown.dwell_speed = { raw: null, contribution: 0, reason: 'no keystrokes this window' };
    breakdown.dwell_cv    = { raw: null, contribution: 0, reason: 'no keystrokes this window' };
    console.log(`   dwell_speed/cv       — no keystrokes`);
  }

  // ⑨ Focus Events — only if focus/blur happened this window
  if (focus.length > 0) {
    apply('focus_events', scoreFocus(focus.length), 0.05);
  } else {
    breakdown.focus_events = { raw: null, contribution: 0, reason: 'no focus events this window' };
    console.log(`   focus_events         — no focus events`);
  }

  delta = Math.round(delta * 100) / 100;
  const projected = Math.round((net_score + delta) * 100) / 100;

  console.log(`\n   DELTA: ${delta > 0 ? '+' : ''}${delta}  |  Projected: ${projected}`);
  console.log('══════════════════════════════════════\n');

  res.json({ kill_switch: false, delta, projected_score: projected, breakdown });
});

app.listen(PORT, () => {
  console.log(`\n✅ PHVS Backend → http://localhost:${PORT}`);
  console.log(`   Score: 0 start | +100 = Bot | -100 = Human`);
  console.log(`   Rule: parameters only score when data exists that window\n`);
});
