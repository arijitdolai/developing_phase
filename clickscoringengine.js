/**
 * Mouse Dynamics Scoring Engine
 * ==============================
 * All scoring logic is pure JS — no I/O, fully testable in isolation.
 *
 * Confidence score architecture
 * ------------------------------
 * Each factor produces a sub-score [0, 100].
 * Sub-scores are combined using fixed weights into an overall score [0, 100].
 *
 * Factor          Weight   Signal
 * -----------     ------   -----------------------------------------------
 * min_interval    0.30     < 80ms is physically implausible for most humans
 * variance        0.20     low std dev = suspiciously machine-like timing
 * regularity      0.20     CV < 0.10 flags robotic cadence
 * clustering      0.15     identical repeated intervals = scripted
 * range_fit       0.15     % of clicks in the natural 150–2000ms band
 *
 * Verdict bands
 * -------------
 * score >= 70  →  human
 * score  40-69 →  uncertain
 * score <  40  →  bot
 */

"use strict";

// ---------------------------------------------------------------------------
// Thresholds (all in milliseconds unless stated)
// ---------------------------------------------------------------------------
const THRESHOLD_BOT_MAX_MS      = 80;
const THRESHOLD_BORDERLINE_MS   = 150;
const THRESHOLD_HUMAN_MIN_MS    = 150;
const THRESHOLD_HUMAN_MAX_MS    = 2000;
const THRESHOLD_BOT_FAST_MAX_MS = 3000;

const THRESHOLD_CV_BOT        = 0.05;
const THRESHOLD_CV_SUSPICIOUS = 0.10;
const THRESHOLD_CV_BORDERLINE = 0.20;

const CLUSTER_TOLERANCE_MS   = 5;
const CLUSTER_BOT_RATIO      = 0.60;
const CLUSTER_SUSPICIOUS_RATIO = 0.30;

const WEIGHTS = {
  min_interval: 0.30,
  variance:     0.20,
  regularity:   0.20,
  clustering:   0.15,
  range_fit:    0.15,
};

const VERDICT_HUMAN     = "human";
const VERDICT_UNCERTAIN = "uncertain";
const VERDICT_BOT       = "bot";

const MIN_INTERVALS_REQUIRED = 2;


// ---------------------------------------------------------------------------
// Data classes → plain JS objects (factory functions)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} IntervalStats
 * @property {number} count
 * @property {number} mean_ms
 * @property {number} std_dev_ms
 * @property {number} min_ms
 * @property {number} max_ms
 * @property {number} cv
 */

/**
 * @typedef {Object} FactorScores
 * @property {number} min_interval
 * @property {number} variance
 * @property {number} regularity
 * @property {number} clustering
 * @property {number} range_fit
 */

/**
 * @typedef {Object} ScoringResult
 * @property {number}       overall_score
 * @property {string}       verdict
 * @property {FactorScores} factors
 * @property {IntervalStats} stats
 * @property {string[]}     flag_reasons
 * @property {boolean}      flagged
 */

/** @param {FactorScores} factors @returns {Object} */
function factorScoresAsDict(factors) {
  return {
    min_interval: factors.min_interval,
    variance:     factors.variance,
    regularity:   factors.regularity,
    clustering:   factors.clustering,
    range_fit:    factors.range_fit,
  };
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a sorted list of click timestamps into inter-click intervals.
 * Returns an empty array if fewer than 2 timestamps are provided.
 *
 * @param {number[]} timestampsMs
 * @returns {number[]}
 */
function computeIntervals(timestampsMs) {
  if (timestampsMs.length < 2) return [];
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  return sorted.slice(1).map((ts, i) => ts - sorted[i]);
}

/**
 * Main entry point. Pass a list of inter-click intervals (ms).
 * Returns null if there are not enough data points to score.
 *
 * @param {number[]} intervals
 * @returns {ScoringResult|null}
 */
function scoreSession(intervals) {
  if (intervals.length < MIN_INTERVALS_REQUIRED) return null;

  const stats   = _computeStats(intervals);
  const factors = _computeFactors(intervals, stats);
  const overall = _weightedOverall(factors);
  const verdict = _classify(overall);

  const result = {
    overall_score: overall,
    verdict,
    factors,
    stats,
    flag_reasons: [],
    flagged: false,
  };

  result.flagged      = verdict === VERDICT_BOT;
  result.flag_reasons = _buildFlagReasons(factors, stats);

  return result;
}


// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** @param {number[]} intervals @returns {IntervalStats} */
function _computeStats(intervals) {
  const n    = intervals.length;
  const mean = intervals.reduce((s, v) => s + v, 0) / n;
  const std  = Math.sqrt(intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / n); // population std dev
  const cv   = mean > 0 ? std / mean : 0;

  return {
    count:      n,
    mean_ms:    _round(mean, 2),
    std_dev_ms: _round(std, 2),
    min_ms:     _round(Math.min(...intervals), 2),
    max_ms:     _round(Math.max(...intervals), 2),
    cv:         _round(cv, 4),
  };
}

/** @param {number[]} intervals @param {IntervalStats} stats @returns {FactorScores} */
function _computeFactors(intervals, stats) {
  return {
    min_interval: _scoreMinInterval(stats.min_ms),
    variance:     _scoreVariance(stats.std_dev_ms),
    regularity:   _scoreRegularity(stats.cv),
    clustering:   _scoreClustering(intervals),
    range_fit:    _scoreRangeFit(intervals),
  };
}

/** @param {FactorScores} f @returns {number} */
function _weightedOverall(f) {
  const raw =
    f.min_interval * WEIGHTS.min_interval +
    f.variance     * WEIGHTS.variance     +
    f.regularity   * WEIGHTS.regularity   +
    f.clustering   * WEIGHTS.clustering   +
    f.range_fit    * WEIGHTS.range_fit;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** @param {number} score @returns {string} */
function _classify(score) {
  if (score >= 70) return VERDICT_HUMAN;
  if (score >= 40) return VERDICT_UNCERTAIN;
  return VERDICT_BOT;
}


// ---------------------------------------------------------------------------
// Individual factor scorers
// ---------------------------------------------------------------------------

/**
 * Hard threshold check.
 * < 80ms   → 0   (impossible for humans under normal conditions)
 * 80-150ms → linear ramp to 60
 * >= 150ms → 100
 *
 * @param {number} minMs
 * @returns {number}
 */
function _scoreMinInterval(minMs) {
  if (minMs < THRESHOLD_BOT_MAX_MS) return 0;
  if (minMs < THRESHOLD_BORDERLINE_MS) {
    return Math.round(
      ((minMs - THRESHOLD_BOT_MAX_MS) / (THRESHOLD_BORDERLINE_MS - THRESHOLD_BOT_MAX_MS)) * 60
    );
  }
  return 100;
}

/**
 * Higher std deviation = more human-like.
 * Capped at std >= 300ms.
 *
 * @param {number} stdDevMs
 * @returns {number}
 */
function _scoreVariance(stdDevMs) {
  const targetStd = 120.0;
  const maxStd    = 300.0;
  if (stdDevMs >= maxStd) return 100;
  return Math.min(100, Math.round((stdDevMs / targetStd) * 100));
}

/**
 * Coefficient of variation (std/mean).
 * Very low CV = machine-like regularity.
 *
 * @param {number} cv
 * @returns {number}
 */
function _scoreRegularity(cv) {
  if (cv < THRESHOLD_CV_BOT) return 0;
  if (cv < THRESHOLD_CV_SUSPICIOUS) {
    return Math.round(
      ((cv - THRESHOLD_CV_BOT) / (THRESHOLD_CV_SUSPICIOUS - THRESHOLD_CV_BOT)) * 30
    );
  }
  if (cv < THRESHOLD_CV_BORDERLINE) {
    return 30 + Math.round(
      ((cv - THRESHOLD_CV_SUSPICIOUS) / (THRESHOLD_CV_BORDERLINE - THRESHOLD_CV_SUSPICIOUS)) * 30
    );
  }
  return 100;
}

/**
 * Count pairs of intervals within CLUSTER_TOLERANCE_MS of each other.
 * A high ratio of such "clones" indicates scripted, repeated timing.
 *
 * @param {number[]} intervals
 * @returns {number}
 */
function _scoreClustering(intervals) {
  const n = intervals.length;
  if (n < 2) return 100;

  let clusterPairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(intervals[i] - intervals[j]) <= CLUSTER_TOLERANCE_MS) {
        clusterPairs++;
      }
    }
  }

  const maxPairs    = (n * (n - 1)) / 2;
  const clusterRatio = maxPairs > 0 ? clusterPairs / maxPairs : 0;

  if (clusterRatio > CLUSTER_BOT_RATIO) return 0;
  if (clusterRatio > CLUSTER_SUSPICIOUS_RATIO) {
    return Math.round(
      (1 - (clusterRatio - CLUSTER_SUSPICIOUS_RATIO) /
           (CLUSTER_BOT_RATIO - CLUSTER_SUSPICIOUS_RATIO)) * 60
    );
  }
  return 100;
}

/**
 * Percentage of intervals within the natural human band [150ms, 2000ms].
 *
 * @param {number[]} intervals
 * @returns {number}
 */
function _scoreRangeFit(intervals) {
  const inRange = intervals.filter(
    iv => iv >= THRESHOLD_HUMAN_MIN_MS && iv <= THRESHOLD_HUMAN_MAX_MS
  ).length;
  return Math.round((inRange / intervals.length) * 100);
}


// ---------------------------------------------------------------------------
// Flag reason builder
// ---------------------------------------------------------------------------

/**
 * @param {FactorScores}   factors
 * @param {IntervalStats}  stats
 * @returns {string[]}
 */
function _buildFlagReasons(factors, stats) {
  const reasons = [];
  if (factors.min_interval === 0) {
    reasons.push(`Minimum interval ${stats.min_ms}ms is below the 80ms human threshold`);
  }
  if (factors.variance < 30) {
    reasons.push(`Std deviation ${stats.std_dev_ms}ms is abnormally low — machine-like timing`);
  }
  if (factors.regularity < 30) {
    reasons.push(`CV=${stats.cv.toFixed(3)} indicates highly regular, robotic cadence`);
  }
  if (factors.clustering < 30) {
    reasons.push("Repeated identical intervals detected — likely scripted automation");
  }
  if (factors.range_fit < 40) {
    reasons.push("Majority of intervals fall outside the normal 150–2000ms human band");
  }
  return reasons;
}


// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Round a number to the given decimal places.
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function _round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}


// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Public API
  computeIntervals,
  scoreSession,
  factorScoresAsDict,
  // Constants (exported for testing / external reference)
  THRESHOLD_BOT_MAX_MS,
  THRESHOLD_BORDERLINE_MS,
  THRESHOLD_HUMAN_MIN_MS,
  THRESHOLD_HUMAN_MAX_MS,
  THRESHOLD_CV_BOT,
  THRESHOLD_CV_SUSPICIOUS,
  THRESHOLD_CV_BORDERLINE,
  CLUSTER_TOLERANCE_MS,
  CLUSTER_BOT_RATIO,
  CLUSTER_SUSPICIOUS_RATIO,
  WEIGHTS,
  VERDICT_HUMAN,
  VERDICT_UNCERTAIN,
  VERDICT_BOT,
  MIN_INTERVALS_REQUIRED,
};