"""
Mouse Dynamics Scoring Engine
==============================
All scoring logic is pure Python — no I/O, fully testable in isolation.

Confidence score architecture
------------------------------
Each factor produces a sub-score [0, 100].
Sub-scores are combined using fixed weights into an overall score [0, 100].

Factor          Weight   Signal
-----------     ------   -----------------------------------------------
min_interval    0.30     < 80ms is physically implausible for most humans
variance        0.20     low std dev = suspiciously machine-like timing
regularity      0.20     CV < 0.10 flags robotic cadence
clustering      0.15     identical repeated intervals = scripted
range_fit       0.15     % of clicks in the natural 150–2000ms band

Verdict bands
-------------
score >= 70  →  human
score  40-69 →  uncertain
score <  40  →  bot
"""

import math
import statistics
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Thresholds (all in milliseconds unless stated)
# ---------------------------------------------------------------------------
THRESHOLD_BOT_MAX_MS       = 80      # Below this → bot signal (hard)
THRESHOLD_BORDERLINE_MS    = 150     # Below this → borderline
THRESHOLD_HUMAN_MIN_MS     = 150     # Bottom of normal human band
THRESHOLD_HUMAN_MAX_MS     = 2000    # Top of normal human band
THRESHOLD_BOT_FAST_MAX_MS  = 3000    # Above this → abnormal slowness

THRESHOLD_CV_BOT           = 0.05    # Coefficient of variation: fully robotic
THRESHOLD_CV_SUSPICIOUS    = 0.10    # Coefficient of variation: suspicious
THRESHOLD_CV_BORDERLINE    = 0.20    # Coefficient of variation: borderline

CLUSTER_TOLERANCE_MS       = 5       # Two intervals considered "same" if within 5ms
CLUSTER_BOT_RATIO          = 0.60    # >60% pairs identical → bot
CLUSTER_SUSPICIOUS_RATIO   = 0.30    # 30-60% pairs identical → suspicious

WEIGHTS = {
    "min_interval": 0.30,
    "variance":     0.20,
    "regularity":   0.20,
    "clustering":   0.15,
    "range_fit":    0.15,
}

VERDICT_HUMAN     = "human"
VERDICT_UNCERTAIN = "uncertain"
VERDICT_BOT       = "bot"

MIN_INTERVALS_REQUIRED = 2   # Minimum intervals before scoring


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class IntervalStats:
    count:      int
    mean_ms:    float
    std_dev_ms: float
    min_ms:     float
    max_ms:     float
    cv:         float


@dataclass
class FactorScores:
    min_interval: int
    variance:     int
    regularity:   int
    clustering:   int
    range_fit:    int

    def as_dict(self) -> dict:
        return {
            "min_interval": self.min_interval,
            "variance":     self.variance,
            "regularity":   self.regularity,
            "clustering":   self.clustering,
            "range_fit":    self.range_fit,
        }


@dataclass
class ScoringResult:
    overall_score:  int
    verdict:        str
    factors:        FactorScores
    stats:          IntervalStats
    flag_reasons:   list[str] = field(default_factory=list)
    flagged:        bool = False

    def __post_init__(self):
        self.flagged = self.verdict == VERDICT_BOT
        self.flag_reasons = _build_flag_reasons(self.factors, self.stats)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def compute_intervals(timestamps_ms: list[int]) -> list[float]:
    """
    Convert a sorted list of click timestamps into inter-click intervals.
    Returns an empty list if fewer than 2 timestamps are provided.
    """
    if len(timestamps_ms) < 2:
        return []
    sorted_ts = sorted(timestamps_ms)
    return [float(sorted_ts[i+1] - sorted_ts[i]) for i in range(len(sorted_ts) - 1)]


def score_session(intervals: list[float]) -> ScoringResult | None:
    """
    Main entry point.  Pass a list of inter-click intervals (ms).
    Returns None if there are not enough data points to score.
    """
    if len(intervals) < MIN_INTERVALS_REQUIRED:
        return None

    stats   = _compute_stats(intervals)
    factors = _compute_factors(intervals, stats)
    overall = _weighted_overall(factors)
    verdict = _classify(overall)

    return ScoringResult(
        overall_score=overall,
        verdict=verdict,
        factors=factors,
        stats=stats,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _compute_stats(intervals: list[float]) -> IntervalStats:
    n      = len(intervals)
    mean   = statistics.mean(intervals)
    std    = statistics.pstdev(intervals)          # population std dev
    cv     = std / mean if mean > 0 else 0.0
    return IntervalStats(
        count      = n,
        mean_ms    = round(mean, 2),
        std_dev_ms = round(std, 2),
        min_ms     = round(min(intervals), 2),
        max_ms     = round(max(intervals), 2),
        cv         = round(cv, 4),
    )


def _compute_factors(intervals: list[float], stats: IntervalStats) -> FactorScores:
    return FactorScores(
        min_interval = _score_min_interval(stats.min_ms),
        variance     = _score_variance(stats.std_dev_ms),
        regularity   = _score_regularity(stats.cv),
        clustering   = _score_clustering(intervals),
        range_fit    = _score_range_fit(intervals),
    )


def _weighted_overall(f: FactorScores) -> int:
    raw = (
        f.min_interval * WEIGHTS["min_interval"] +
        f.variance     * WEIGHTS["variance"]     +
        f.regularity   * WEIGHTS["regularity"]   +
        f.clustering   * WEIGHTS["clustering"]   +
        f.range_fit    * WEIGHTS["range_fit"]
    )
    return max(0, min(100, round(raw)))


def _classify(score: int) -> str:
    if score >= 70:
        return VERDICT_HUMAN
    if score >= 40:
        return VERDICT_UNCERTAIN
    return VERDICT_BOT


# ---------------------------------------------------------------------------
# Individual factor scorers
# ---------------------------------------------------------------------------

def _score_min_interval(min_ms: float) -> int:
    """
    Hard threshold check.
    < 80ms  → 0  (impossible for humans under normal conditions)
    80-150ms → 40 (very fast, borderline)
    >= 150ms → 100
    """
    if min_ms < THRESHOLD_BOT_MAX_MS:
        return 0
    if min_ms < THRESHOLD_BORDERLINE_MS:
        # Linear ramp 0→100 between 80 and 150ms
        return round((min_ms - THRESHOLD_BOT_MAX_MS) / (THRESHOLD_BORDERLINE_MS - THRESHOLD_BOT_MAX_MS) * 60)
    return 100


def _score_variance(std_dev_ms: float) -> int:
    """
    Higher std deviation = more human-like.
    Humans typically show > 80-120ms std dev between clicks.
    Cap reward at std >= 300ms (beyond that variance isn't extra evidence).
    """
    target_std = 120.0
    max_std    = 300.0
    if std_dev_ms >= max_std:
        return 100
    return min(100, round((std_dev_ms / target_std) * 100))


def _score_regularity(cv: float) -> int:
    """
    Coefficient of variation (std/mean).
    Very low CV = machine-like regularity.
    < 0.05  → 0
    0.05-0.10 → 0-30 (linear)
    0.10-0.20 → 30-60 (linear)
    >= 0.20  → 100
    """
    if cv < THRESHOLD_CV_BOT:
        return 0
    if cv < THRESHOLD_CV_SUSPICIOUS:
        return round((cv - THRESHOLD_CV_BOT) / (THRESHOLD_CV_SUSPICIOUS - THRESHOLD_CV_BOT) * 30)
    if cv < THRESHOLD_CV_BORDERLINE:
        return 30 + round((cv - THRESHOLD_CV_SUSPICIOUS) / (THRESHOLD_CV_BORDERLINE - THRESHOLD_CV_SUSPICIOUS) * 30)
    return 100


def _score_clustering(intervals: list[float]) -> int:
    """
    Count pairs of intervals that are within CLUSTER_TOLERANCE_MS of each other.
    A high ratio of such 'clones' indicates scripted, repeated timing.
    """
    n = len(intervals)
    if n < 2:
        return 100

    cluster_pairs = sum(
        1
        for i in range(n)
        for j in range(i + 1, n)
        if abs(intervals[i] - intervals[j]) <= CLUSTER_TOLERANCE_MS
    )
    max_pairs   = (n * (n - 1)) / 2
    cluster_ratio = cluster_pairs / max_pairs if max_pairs > 0 else 0.0

    if cluster_ratio > CLUSTER_BOT_RATIO:
        return 0
    if cluster_ratio > CLUSTER_SUSPICIOUS_RATIO:
        return round((1 - (cluster_ratio - CLUSTER_SUSPICIOUS_RATIO) /
                      (CLUSTER_BOT_RATIO - CLUSTER_SUSPICIOUS_RATIO)) * 60)
    return 100


def _score_range_fit(intervals: list[float]) -> int:
    """
    Percentage of intervals within the natural human band [150ms, 2000ms].
    Pure count-based — each out-of-range interval penalises linearly.
    """
    in_range = sum(1 for iv in intervals if THRESHOLD_HUMAN_MIN_MS <= iv <= THRESHOLD_HUMAN_MAX_MS)
    return round((in_range / len(intervals)) * 100)


# ---------------------------------------------------------------------------
# Flag reason builder
# ---------------------------------------------------------------------------

def _build_flag_reasons(factors: FactorScores, stats: IntervalStats) -> list[str]:
    reasons = []
    if factors.min_interval == 0:
        reasons.append(f"Minimum interval {stats.min_ms}ms is below the 80ms human threshold")
    if factors.variance < 30:
        reasons.append(f"Std deviation {stats.std_dev_ms}ms is abnormally low — machine-like timing")
    if factors.regularity < 30:
        reasons.append(f"CV={stats.cv:.3f} indicates highly regular, robotic cadence")
    if factors.clustering < 30:
        reasons.append("Repeated identical intervals detected — likely scripted automation")
    if factors.range_fit < 40:
        reasons.append("Majority of intervals fall outside the normal 150–2000ms human band")
    return reasons