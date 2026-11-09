// Detects workflows that trigger themselves or run far more often than a human
// would expect. Reads execution history only; it never stops anything itself —
// pausing is a human action, and the Shepherd screen shows the finding.

const DEFAULT_MAX_PER_MINUTE = 60;

export function analyseExecutions(executions, { maxPerMinute = DEFAULT_MAX_PER_MINUTE, now = Date.now() } = {}) {
  const byWorkflow = new Map();
  for (const ex of executions) {
    const started = Date.parse(ex.startedAt);
    if (Number.isNaN(started)) continue;
    if (!byWorkflow.has(ex.workflowId)) byWorkflow.set(ex.workflowId, []);
    byWorkflow.get(ex.workflowId).push(started);
  }

  const findings = [];
  for (const [workflowId, times] of byWorkflow) {
    times.sort((a, b) => a - b);

    // Highest count inside any rolling 60s window.
    let peak = 0;
    let peakAt = null;
    let start = 0;
    for (let end = 0; end < times.length; end += 1) {
      while (times[end] - times[start] > 60_000) start += 1;
      const count = end - start + 1;
      if (count > peak) {
        peak = count;
        peakAt = times[end];
      }
    }

    if (peak > maxPerMinute) {
      findings.push({
        workflowId,
        kind: "rate",
        severity: "stop",
        detail: `ran ${peak}× in one minute (limit ${maxPerMinute})`,
        at: new Date(peakAt).toISOString()
      });
    }

    // A workflow whose runs are spaced under a second apart, sustained, is
    // almost always a self-trigger loop rather than a busy schedule.
    if (times.length >= 10) {
      const recent = times.filter((t) => now - t < 15 * 60_000);
      if (recent.length >= 10) {
        const span = recent[recent.length - 1] - recent[0];
        const avgGap = span / (recent.length - 1);
        if (avgGap < 1000) {
          findings.push({
            workflowId,
            kind: "self-trigger",
            severity: "stop",
            detail: `${recent.length} runs in 15 min, ${Math.round(avgGap)}ms apart — looks self-triggered`,
            at: new Date(recent[recent.length - 1]).toISOString()
          });
        }
      }
    }
  }
  return findings;
}

// Groups repeated failures of the same workflow so the owner gets one alert,
// not one per run.
export function groupFailures(executions, { windowMinutes = 60 } = {}) {
  const groups = new Map();
  for (const ex of executions) {
    if (ex.status !== "error" && ex.status !== "crashed") continue;
    const key = ex.workflowId;
    if (!groups.has(key)) {
      groups.set(key, { workflowId: key, count: 0, first: ex.startedAt, last: ex.startedAt, executionIds: [] });
    }
    const g = groups.get(key);
    g.count += 1;
    g.executionIds.push(ex.id);
    if (Date.parse(ex.startedAt) < Date.parse(g.first)) g.first = ex.startedAt;
    if (Date.parse(ex.startedAt) > Date.parse(g.last)) g.last = ex.startedAt;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    windowMinutes,
    detail: `${g.count} failure${g.count === 1 ? "" : "s"} between ${g.first} and ${g.last}`
  }));
}

// Typical run time from real executions: median and 90th percentile. An
// average is the wrong number here, because a handful of runs parked on a
// Wait node for hours drag it into the tens of minutes while almost every run
// takes under two seconds.
export function runTimeStats(executions) {
  const ms = (executions || [])
    .filter((e) => e.startedAt && e.stoppedAt)
    .map((e) => Date.parse(e.stoppedAt) - Date.parse(e.startedAt))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (!ms.length) return null;
  const at = (p) => ms[Math.min(ms.length - 1, Math.floor(p * (ms.length - 1)))];
  return { count: ms.length, medianMs: at(0.5), p90Ms: at(0.9), maxMs: ms[ms.length - 1] };
}
