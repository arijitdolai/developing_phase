/**
 * ================================================================
 *  BotShield — Server-Side Honeypot + Behavioral Validation
 *  Works as Express middleware. Pair with the frontend index.html
 * ================================================================
 *
 *  npm install express express-rate-limit express-session
 *
 *  Usage:
 *    const { botShieldMiddleware } = require('./botshield-server');
 *    app.post('/login', botShieldMiddleware, yourLoginHandler);
 * ================================================================
 */

const rateLimit = require('express-rate-limit');
const session   = require('express-session');

// ── In-memory block list (replace with Redis/DB in production) ──
const blockedIPs     = new Set();
const blockedSessions= new Set();

// ── Config ──────────────────────────────────────────────────────
const CONFIG = {
  MIN_FILL_TIME_MS : 800,    // Faster = auto-block
  SOFT_FILL_TIME_MS: 3000,   // Faster but > min = +risk
  RISK_THRESHOLD   : 3,      // Score ≥ this = block
  HONEYPOT_FIELDS  : ['email', 'phone', 'website'], // Must match frontend
};

// ── Rate limiter: brute-force protection ────────────────────────
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // Max 10 login attempts per IP per window
  message: { error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    console.warn(`[BotShield] Rate limit hit: ${req.ip}`);
    blockIP(req.ip, 'RATE_LIMIT_EXCEEDED');
    res.status(429).json({ error: options.message.error, blocked: true });
  }
});

// ── Main middleware ─────────────────────────────────────────────
function botShieldMiddleware(req, res, next) {
  const ip = getClientIP(req);

  // 1. Check if IP is already hard-blocked
  if (blockedIPs.has(ip)) {
    return res.status(403).json({
      error  : 'ACCESS DENIED',
      reason : 'IP_PREVIOUSLY_BLOCKED',
      blocked: true,
    });
  }

  // 2. Check if session is already flagged
  if (req.session && blockedSessions.has(req.session.id)) {
    return res.status(403).json({
      error  : 'ACCESS DENIED',
      reason : 'SESSION_PREVIOUSLY_BLOCKED',
      blocked: true,
    });
  }

  const body      = req.body || {};
  let   riskScore = 0;
  const reasons   = [];

  // ── Signal 1: Honeypot fields — hard block if any are filled ──
  for (const field of CONFIG.HONEYPOT_FIELDS) {
    if (body[field] && body[field].toString().trim().length > 0) {
      blockIP(ip, `HONEYPOT_FIELD:${field.toUpperCase()}`);
      if (req.session) blockSession(req.session.id, `HONEYPOT_FIELD:${field}`);
      return res.status(403).json({
        error  : 'ACCESS DENIED',
        reason : `HONEYPOT_TRIGGERED:${field.toUpperCase()}`,
        blocked: true,
      });
    }
  }

  // ── Signal 2: Form fill time ───────────────────────────────────
  const timeStart = parseInt(body.time_start, 10);
  if (timeStart && !isNaN(timeStart)) {
    const fillTime = Date.now() - timeStart;
    if (fillTime < CONFIG.MIN_FILL_TIME_MS) {
      // Hard block — way too fast
      blockIP(ip, `FILL_TOO_FAST_${fillTime}MS`);
      if (req.session) blockSession(req.session.id, 'FILL_TOO_FAST');
      return res.status(403).json({
        error  : 'ACCESS DENIED',
        reason : `SUBMISSION_TOO_FAST:${fillTime}MS`,
        blocked: true,
      });
    }
    if (fillTime < CONFIG.SOFT_FILL_TIME_MS) {
      riskScore += 2;
      reasons.push('FAST_FILL');
    }
  } else {
    // Missing timing token is suspicious
    riskScore += 2;
    reasons.push('MISSING_TIMING_TOKEN');
  }

  // ── Signal 3: Mouse/interaction count ─────────────────────────
  const moveCount = parseInt(body.move_count, 10) || 0;
  if (moveCount === 0) {
    riskScore += 2;
    reasons.push('NO_MOUSE_ACTIVITY');
  } else if (moveCount < 3) {
    riskScore += 1;
    reasons.push('LOW_MOUSE_ACTIVITY');
  }

  // ── Signal 4: Missing hidden form_token ───────────────────────
  if (!body.form_token || body.form_token.toString().trim() === '') {
    riskScore += 1;
    reasons.push('MISSING_FORM_TOKEN');
  }

  // ── Signal 5: User-Agent checks ───────────────────────────────
  const ua = req.headers['user-agent'] || '';
  if (!ua || ua.length < 10) {
    riskScore += 2;
    reasons.push('MISSING_OR_SHORT_UA');
  }
  const botPatterns = [/bot/i, /crawl/i, /spider/i, /scraper/i, /curl/i, /wget/i, /python-requests/i, /axios/i, /go-http/i, /java\//i];
  if (botPatterns.some(p => p.test(ua))) {
    blockIP(ip, 'BOT_USER_AGENT');
    return res.status(403).json({
      error  : 'ACCESS DENIED',
      reason : 'BOT_USER_AGENT_DETECTED',
      blocked: true,
    });
  }

  // ── Signal 6: Accept-Language header (bots often omit it) ─────
  if (!req.headers['accept-language']) {
    riskScore += 1;
    reasons.push('MISSING_ACCEPT_LANGUAGE');
  }

  // ── Decision ──────────────────────────────────────────────────
  if (riskScore >= CONFIG.RISK_THRESHOLD) {
    blockIP(ip, `RISK_SCORE_${riskScore}:${reasons.join(',')}`);
    if (req.session) blockSession(req.session.id, `RISK_SCORE_${riskScore}`);
    return res.status(403).json({
      error  : 'ACCESS DENIED',
      reason : `HIGH_RISK_SCORE:${riskScore}`,
      signals: reasons,
      blocked: true,
    });
  }

  // ── Passed all checks — attach score to request for logging ───
  req.botShield = { riskScore, reasons, ip };
  console.log(`[BotShield] PASS | IP: ${ip} | Score: ${riskScore} | Reasons: ${reasons.join(',') || 'none'}`);
  next();
}

// ── Block helpers ────────────────────────────────────────────────
function blockIP(ip, reason) {
  blockedIPs.add(ip);
  console.warn(`[BotShield] BLOCKED IP: ${ip} | Reason: ${reason}`);
  // In production: write to DB / Redis with TTL, alert admin, etc.
}

function blockSession(sessionId, reason) {
  blockedSessions.add(sessionId);
  console.warn(`[BotShield] BLOCKED Session: ${sessionId} | Reason: ${reason}`);
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── Admin helpers (call from your admin panel) ─────────────────
function unblockIP(ip)          { blockedIPs.delete(ip); }
function unblockSession(sid)    { blockedSessions.delete(sid); }
function getBlockedIPs()        { return [...blockedIPs]; }
function getBlockedSessions()   { return [...blockedSessions]; }

// ── Session middleware factory ─────────────────────────────────
function createSessionMiddleware(secret = 'change-this-secret-in-production') {
  return session({
    secret,
    resave           : false,
    saveUninitialized: false,
    cookie           : {
      httpOnly: true,
      secure  : process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge  : 30 * 60 * 1000, // 30 minutes
    },
  });
}

// ── Middleware to block bots from ALL further pages ────────────
function globalBotGuard(req, res, next) {
  const ip = getClientIP(req);
  if (blockedIPs.has(ip)) {
    return res.status(403).json({ error: 'ACCESS DENIED', reason: 'IP_BLOCKED' });
  }
  if (req.session && blockedSessions.has(req.session.id)) {
    return res.status(403).json({ error: 'ACCESS DENIED', reason: 'SESSION_BLOCKED' });
  }
  next();
}

// ── Example Express app wiring ─────────────────────────────────
/*
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(createSessionMiddleware('your-secret-here'));
app.use(loginRateLimiter);    // Rate limit all routes
app.use(globalBotGuard);      // Block known-bad IPs/sessions on ALL routes

// Login route — runs full honeypot check
app.post('/login', botShieldMiddleware, (req, res) => {
  const { username, password } = req.body;
  // ... your real auth logic here ...
  res.json({ success: true, message: 'Login successful' });
});

// Protected route — only needs globalBotGuard (already applied above)
app.get('/dashboard', (req, res) => {
  res.json({ message: 'Welcome, human!' });
});

app.listen(3000, () => console.log('[BotShield] Server running on :3000'));
*/

module.exports = {
  botShieldMiddleware,
  loginRateLimiter,
  globalBotGuard,
  createSessionMiddleware,
  unblockIP,
  unblockSession,
  getBlockedIPs,
  getBlockedSessions,
};