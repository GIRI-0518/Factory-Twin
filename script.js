/**
 * PRODUCTION LINE DIGITAL TWIN — SIMULATION ENGINE
 * ===================================================
 * Architecture:
 *   SimEngine  — pure simulation state + tick logic (no DOM)
 *   Renderer   — reads SimEngine state, updates DOM
 *   Controls   — wires sliders/buttons to SimEngine
 *   RecommendationEngine — shadow-simulation + analysis
 *   App        — initialises everything, manages tabs
 *
 * Tick model: 1 tick = 1 simulated second
 * Real-time interval = adjustable (slow/normal/fast)
 */

'use strict';

/* ============================================================
   1. SIMULATION ENGINE
   Pure state machine — zero DOM access allowed here.
   ============================================================ */
const SimEngine = (() => {

  // ---- Default stage definitions ----
  const DEFAULT_STAGES = [
    { name: 'Raw Input',   icon: '📦', cycleTime: 4,  capacity: 1.0 },
    { name: 'Cutting',     icon: '✂️',  cycleTime: 6,  capacity: 1.0 },
    { name: 'Welding',     icon: '🔥', cycleTime: 9,  capacity: 1.0 },
    { name: 'Assembly',    icon: '🔧', cycleTime: 7,  capacity: 1.0 },
    { name: 'Quality Ctrl',icon: '🔬', cycleTime: 5,  capacity: 1.0 },
    { name: 'Packaging',   icon: '📫', cycleTime: 4,  capacity: 1.0 },
  ];

  // ---- State ----
  let stages = [];
  let tick = 0;
  let completedUnits = 0;
  let throughputHistory = [];   // rolling 60-tick window
  let tickHistory = [];         // array of {tick, completed} for chart
  let isPaused = false;
  let intervalId = null;
  let speedMs = 200;            // ms per tick (real time)

  // breakdown timers: { stageIndex: ticksRemaining }
  let breakdownTimers = {};

  // listeners for render updates
  let onTickCallbacks = [];

  // ---- Initialise / Reset ----
  function init(stageOverrides) {
    clearInterval(intervalId);
    intervalId = null;
    tick = 0;
    completedUnits = 0;
    throughputHistory = [];
    tickHistory = [];
    breakdownTimers = {};
    isPaused = false;

    const defs = stageOverrides || DEFAULT_STAGES;
    stages = defs.map((def, i) => ({
      id: i,
      name: def.name,
      icon: def.icon || '⚙️',
      // base values (restored on reset)
      baseCycleTime: def.cycleTime,
      baseCapacity: def.capacity,
      // live values (can be changed via sliders)
      cycleTime: def.cycleTime,
      capacity: def.capacity,
      // simulation state
      buffer: [],               // queue of unit objects
      busyUntilTick: 0,         // tick at which current unit completes
      currentUnit: null,        // unit being processed
      // counters
      utilizationTicks: 0,
      idleTicks: 0,
      starvedTicks: 0,
      blockedTicks: 0,
      totalProcessed: 0,
      // status
      status: 'idle',
      breakdown: false,
      breakdownSaved: 1.0,      // capacity saved before breakdown
    }));
  }

  // ---- Unit factory ----
  let unitSeq = 0;
  function makeUnit() { return { id: ++unitSeq, createdAt: tick }; }

  // ---- Effective cycle time ----
  function effectiveCycleTime(stage) {
    if (stage.capacity <= 0) return Infinity;
    return stage.cycleTime / stage.capacity;
  }

  // ---- Tick logic ----
  function doTick() {
    if (isPaused) return;
    tick++;

    // Handle breakdown timers
    for (const idx in breakdownTimers) {
      breakdownTimers[idx]--;
      if (breakdownTimers[idx] <= 0) {
        // Restore capacity
        stages[idx].capacity = stages[idx].breakdownSaved;
        stages[idx].breakdown = false;
        delete breakdownTimers[idx];
      }
    }

    // Step 1: Push completed units to next stage (iterate from last to first to avoid double-processing)
    for (let i = stages.length - 1; i >= 0; i--) {
      const stage = stages[i];
      if (stage.currentUnit && tick >= stage.busyUntilTick) {
        const finished = stage.currentUnit;
        stage.currentUnit = null;
        stage.totalProcessed++;
        if (i === stages.length - 1) {
          // Last stage — ship it
          completedUnits++;
        } else {
          // Push to next stage's buffer
          stages[i + 1].buffer.push(finished);
        }
      }
    }

    // Step 2: Start processing for idle stages
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (stage.currentUnit !== null) continue; // already busy

      let hasInput = false;
      if (i === 0) {
        // Stage 0 has infinite source — always has input available
        hasInput = true;
      } else {
        hasInput = stage.buffer.length > 0;
      }

      if (hasInput && stage.capacity > 0) {
        const unit = (i === 0) ? makeUnit() : stage.buffer.shift();
        stage.currentUnit = unit;
        const ct = effectiveCycleTime(stage);
        stage.busyUntilTick = tick + ct;
        stage.status = 'processing';
        stage.utilizationTicks++;
      } else if (!hasInput) {
        stage.status = 'starved';
        stage.starvedTicks++;
        stage.idleTicks++;
      } else if (stage.capacity <= 0) {
        // Breakdown
        stage.status = 'breakdown';
        stage.idleTicks++;
      } else {
        stage.status = 'idle';
        stage.idleTicks++;
      }
    }

    // Step 3: Update status for stages currently processing
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (stage.currentUnit !== null) {
        stage.utilizationTicks++;
        stage.status = 'processing';
      }
    }

    // Step 4: Check for blocked status (buffer in NEXT stage exceeding threshold)
    // A stage is "blocked" if it just finished but nowhere to push (simplified: if downstream buffer > 20)
    for (let i = 0; i < stages.length - 1; i++) {
      if (stages[i + 1].buffer.length > 20 && stages[i].currentUnit === null) {
        stages[i].status = 'blocked';
        stages[i].blockedTicks++;
      }
    }

    // Step 5: Throughput tracking
    throughputHistory.push(completedUnits);
    if (throughputHistory.length > tick) throughputHistory = throughputHistory.slice(-60);

    // Units completed in last 60 ticks
    const windowStart = throughputHistory.length > 60
      ? throughputHistory[throughputHistory.length - 61]
      : 0;
    const windowEnd = throughputHistory[throughputHistory.length - 1];
    const unitsInWindow = windowEnd - windowStart;
    const windowTicks = Math.min(tick, 60);
    // Convert to units/min: 1 tick = 1 sim-second → 60 ticks = 1 sim-minute
    const throughputPerMin = windowTicks > 0 ? (unitsInWindow / windowTicks) * 60 : 0;

    tickHistory.push({ tick, throughput: throughputPerMin, completed: completedUnits });
    if (tickHistory.length > 200) tickHistory.shift();

    // Step 6: Compute bottleneck score per stage
    // Score = normalized(utilization) * 0.5 + normalized(bufferLength) * 0.5
    // Pick stage with highest score
    const totalTicks = tick || 1;
    const maxBuf = Math.max(...stages.map(s => s.buffer.length), 1);

    stages.forEach(s => {
      const util = (s.utilizationTicks / totalTicks);
      const bufScore = s.buffer.length / (maxBuf || 1);
      s.bottleneckScore = util * 0.5 + bufScore * 0.5;
      s.utilization = util * 100;
    });

    // Notify render layer
    onTickCallbacks.forEach(cb => cb(getSnapshot()));
  }

  // ---- Snapshot (immutable copy for render) ----
  function getSnapshot() {
    const totalTicks = tick || 1;
    const windowSize = Math.min(tick, 60);
    const windowStart = throughputHistory.length > 60
      ? throughputHistory[throughputHistory.length - 61]
      : 0;
    const windowEnd = throughputHistory[throughputHistory.length - 1] || 0;
    const unitsInWindow = windowEnd - windowStart;
    const tpPerMin = windowSize > 0 ? (unitsInWindow / windowSize) * 60 : 0;

    // Previous window
    const prevWindowStart = throughputHistory.length > 121
      ? throughputHistory[throughputHistory.length - 121]
      : 0;
    const prevWindowEnd = throughputHistory.length > 61
      ? throughputHistory[throughputHistory.length - 61]
      : 0;
    const prevUnits = prevWindowEnd - prevWindowStart;
    const prevTP = windowSize > 0 ? (prevUnits / windowSize) * 60 : 0;

    // Find bottleneck: highest bottleneckScore, skip if in breakdown (they are trivially the constraint)
    const activeStages = stages.filter(s => !s.breakdown);
    let bottleneckIdx = -1;
    let topScore = -1;
    stages.forEach((s, i) => {
      if (s.bottleneckScore > topScore) {
        topScore = s.bottleneckScore;
        bottleneckIdx = i;
      }
    });

    const stagesCopy = stages.map((s, i) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      cycleTime: s.cycleTime,
      capacity: s.capacity,
      baseCycleTime: s.baseCycleTime,
      baseCapacity: s.baseCapacity,
      buffer: s.buffer.length,
      status: s.status,
      breakdown: s.breakdown,
      utilizationTicks: s.utilizationTicks,
      idleTicks: s.idleTicks,
      starvedTicks: s.starvedTicks,
      blockedTicks: s.blockedTicks,
      totalProcessed: s.totalProcessed,
      utilization: s.utilization,
      bottleneckScore: s.bottleneckScore,
      isBottleneck: i === bottleneckIdx,
      currentUnit: s.currentUnit,
    }));

    return {
      tick,
      completedUnits,
      throughputPerMin: tpPerMin,
      prevThroughputPerMin: prevTP,
      tickHistory: [...tickHistory],
      stages: stagesCopy,
      bottleneckIdx,
      bottleneckStage: bottleneckIdx >= 0 ? stagesCopy[bottleneckIdx] : null,
      isPaused,
    };
  }

  // ---- Public API ----
  function start() {
    if (intervalId) return;
    intervalId = setInterval(doTick, speedMs);
    isPaused = false;
  }

  function pause() {
    isPaused = true;
  }

  function resume() {
    isPaused = false;
  }

  function stop() {
    clearInterval(intervalId);
    intervalId = null;
  }

  function setSpeed(ms) {
    speedMs = ms;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = setInterval(doTick, speedMs);
    }
  }

  function setStageParam(stageIdx, param, value) {
    if (!stages[stageIdx]) return;
    stages[stageIdx][param] = value;
  }

  function triggerBreakdown(stageIdx, durationTicks = 20) {
    const s = stages[stageIdx];
    if (!s) return;
    s.breakdownSaved = s.capacity > 0 ? s.capacity : 1.0;
    s.capacity = 0;
    s.breakdown = true;
    breakdownTimers[stageIdx] = durationTicks;
  }

  function reset() {
    stop();
    init();
    start();
  }

  function onTick(cb) {
    onTickCallbacks.push(cb);
  }

  function getStagesDirect() { return stages; }

  // Shadow simulation: clone state and fast-forward N ticks
  function shadowSimulate(stageOverrides, ticks = 120) {
    // Deep clone stages
    const shadowStages = stages.map((s, i) => ({
      ...s,
      capacity: (stageOverrides && stageOverrides[i] !== undefined) ? stageOverrides[i].capacity : s.capacity,
      cycleTime: (stageOverrides && stageOverrides[i] !== undefined) ? stageOverrides[i].cycleTime : s.cycleTime,
      buffer: [...s.buffer],
      currentUnit: s.currentUnit ? { ...s.currentUnit } : null,
      utilizationTicks: s.utilizationTicks,
      idleTicks: s.idleTicks,
      starvedTicks: s.starvedTicks,
    }));

    let shadowTick = tick;
    let shadowCompleted = completedUnits;
    let shadowSeq = unitSeq + 1000000;

    function shadowMakeUnit() { return { id: ++shadowSeq, createdAt: shadowTick }; }

    for (let t = 0; t < ticks; t++) {
      shadowTick++;

      // Push completed
      for (let i = shadowStages.length - 1; i >= 0; i--) {
        const s = shadowStages[i];
        if (s.currentUnit && shadowTick >= s.busyUntilTick) {
          const finished = s.currentUnit;
          s.currentUnit = null;
          s.totalProcessed = (s.totalProcessed || 0) + 1;
          if (i === shadowStages.length - 1) {
            shadowCompleted++;
          } else {
            shadowStages[i + 1].buffer.push(finished);
          }
        }
      }

      // Start processing
      for (let i = 0; i < shadowStages.length; i++) {
        const s = shadowStages[i];
        if (s.currentUnit !== null) continue;
        const hasInput = (i === 0) || s.buffer.length > 0;
        if (hasInput && s.capacity > 0) {
          const unit = (i === 0) ? shadowMakeUnit() : s.buffer.shift();
          s.currentUnit = unit;
          const ct = s.capacity > 0 ? (s.cycleTime / s.capacity) : Infinity;
          s.busyUntilTick = shadowTick + ct;
          s.utilizationTicks = (s.utilizationTicks || 0) + 1;
        } else {
          s.idleTicks = (s.idleTicks || 0) + 1;
        }
      }
      for (let i = 0; i < shadowStages.length; i++) {
        if (shadowStages[i].currentUnit !== null) {
          shadowStages[i].utilizationTicks = (shadowStages[i].utilizationTicks || 0) + 1;
        }
      }
    }

    const newCompleted = shadowCompleted - completedUnits;
    const tpPerMin = (newCompleted / ticks) * 60;
    const totalT = shadowTick;

    // Compute utilization for shadow stages
    const shadowUtil = shadowStages.map(s => ({
      name: s.name,
      utilization: ((s.utilizationTicks || 0) / (totalT || 1)) * 100,
      buffer: s.buffer.length,
    }));

    // Find new bottleneck in shadow
    let newBottleneckIdx = 0;
    let maxU = -1;
    shadowUtil.forEach((s, i) => {
      if (s.utilization > maxU) { maxU = s.utilization; newBottleneckIdx = i; }
    });

    return {
      throughputPerMin: tpPerMin,
      stageUtils: shadowUtil,
      newBottleneckIdx,
      newBottleneckName: shadowUtil[newBottleneckIdx]?.name,
      newBottleneckUtil: shadowUtil[newBottleneckIdx]?.utilization,
    };
  }

  // Initialise on load
  init();

  return {
    init, start, stop, pause, resume, reset,
    setSpeed, setStageParam, triggerBreakdown,
    onTick, getSnapshot, getStagesDirect, shadowSimulate,
    getDefaultStages: () => DEFAULT_STAGES,
  };
})();


/* ============================================================
   2. RECOMMENDATION ENGINE
   Runs shadow simulations to generate actionable insights.
   Fully decoupled from DOM — returns plain objects.
   ============================================================ */
const RecommendationEngine = (() => {

  let lastResult = null;

  /**
   * Analyse current state and produce a recommendation object.
   *
   * CEILING-AWARE LOGIC
   * -------------------
   * A stage's capacity is bounded [0, 1.0] in the base model (1.0 = 100% of one
   * machine's rated throughput). When a stage is already AT ceiling (capacity >= 1.0):
   *
   *   • Scenario A  — "+20% capacity" is physically impossible (no headroom).
   *     Instead we escalate to a "parallel machine" model: the shadow simulation
   *     runs with capacity = min(2.0, current * 2), representing a second identical
   *     machine in parallel. The label and description change accordingly.
   *     If headroom exists but is < 20pp, we clamp to exactly 100% and label the
   *     actual achievable gain ("partial headroom").
   *
   *   • Scenario C  — "+20% capacity across top-2 stages" silently clips stages
   *     already at ceiling to 1.0, which produces 0 gain for those stages and
   *     misleadingly inflated labels. Now each stage in the top-2 is evaluated
   *     independently: if at ceiling → parallel machine (cap 2.0), otherwise +20%
   *     capped at 1.0. The scenario label reflects whichever intervention applies.
   *
   *   • Scenario B  — cycle-time reduction is always physically possible (no ceiling),
   *     so it remains unchanged.
   *
   * The returned object gains two new fields:
   *   atCeiling      {boolean} — true if the bottleneck is already at 100% capacity
   *   ceilingWarning {string}  — human-readable explanation for the UI to surface
   *
   * @param {object} snapshot - from SimEngine.getSnapshot()
   * @returns {object} recommendation
   */
  function analyse(snapshot) {
    if (!snapshot || snapshot.tick < 10) {
      return { ready: false, reason: 'Collecting data...' };
    }

    const { stages, bottleneckIdx, throughputPerMin } = snapshot;
    if (bottleneckIdx < 0) return { ready: false, reason: 'No bottleneck detected yet.' };

    const bn = stages[bottleneckIdx];
    const currentTP = throughputPerMin;

    // ---- Ceiling detection helpers ----
    const CAP_CEILING = 1.0;   // max single-machine capacity
    const CAP_PARALLEL = 2.0;  // modelled capacity with one parallel machine added

    /**
     * Return the ceiling-aware override capacity for a stage.
     * If the stage has headroom, apply +20pp capped at ceiling.
     * If already at ceiling, model a parallel machine (× 2, capped at CAP_PARALLEL).
     * Returns { newCap, mode } where mode is 'boost' | 'partial' | 'parallel'.
     */
    function ceilingAwareCapacity(stageCap) {
      const headroom = CAP_CEILING - stageCap;
      if (headroom <= 0) {
        // Already at ceiling — parallel machine model
        return { newCap: Math.min(CAP_PARALLEL, stageCap * 2), mode: 'parallel' };
      } else if (headroom < 0.20) {
        // Partial headroom: can only add headroom amount, not full +20%
        return { newCap: CAP_CEILING, mode: 'partial', actualGain: headroom };
      } else {
        // Full +20pp boost available
        return { newCap: stageCap + 0.20, mode: 'boost' };
      }
    }

    // ---- Scenario A: capacity intervention at bottleneck (ceiling-aware) ----
    const bnCapResult = ceilingAwareCapacity(bn.capacity);
    const atCeiling = bnCapResult.mode === 'parallel';
    const partialHeadroom = bnCapResult.mode === 'partial';

    const overridesA = {};
    overridesA[bottleneckIdx] = { capacity: bnCapResult.newCap, cycleTime: bn.cycleTime };
    const shadowA = SimEngine.shadowSimulate(overridesA, 120);

    // Build a human-readable label and description for Scenario A
    let scenarioAName, scenarioADesc;
    if (atCeiling) {
      scenarioAName = `Add parallel machine at ${bn.name}`;
      scenarioADesc = `capacity ceiling hit (${(bn.capacity * 100).toFixed(0)}%) — modelled as 2nd parallel machine (${(bnCapResult.newCap * 100).toFixed(0)}% effective)`;
    } else if (partialHeadroom) {
      const gainPp = (bnCapResult.actualGain * 100).toFixed(0);
      scenarioAName = `Fill remaining capacity at ${bn.name} (+${gainPp}pp)`;
      scenarioADesc = `partial headroom only: ${(bn.capacity * 100).toFixed(0)}% → ${(CAP_CEILING * 100).toFixed(0)}% (${gainPp}pp gain, not +20pp)`;
    } else {
      scenarioAName = `+20% Capacity → ${bn.name}`;
      scenarioADesc = `capacity ${(bn.capacity * 100).toFixed(0)}% → ${(bnCapResult.newCap * 100).toFixed(0)}%`;
    }

    // ---- Scenario B: -20% cycle time at bottleneck (always available) ----
    const overridesB = {};
    overridesB[bottleneckIdx] = {
      capacity: bn.capacity,
      cycleTime: Math.max(1, bn.cycleTime * 0.80),
    };
    const shadowB = SimEngine.shadowSimulate(overridesB, 120);

    // ---- Scenario C: capacity intervention across top-2 stages (ceiling-aware) ----
    const overridesC = {};
    const sortedByUtil = [...stages].sort((a, b) => b.utilization - a.utilization);
    const top2 = sortedByUtil.slice(0, 2);
    const top2Labels = [];
    top2.forEach(s => {
      const result = ceilingAwareCapacity(s.capacity);
      overridesC[s.id] = { capacity: result.newCap, cycleTime: s.cycleTime };
      if (result.mode === 'parallel') {
        top2Labels.push(`${s.name} (parallel)`);
      } else if (result.mode === 'partial') {
        top2Labels.push(`${s.name} (+${(result.actualGain * 100).toFixed(0)}pp)`);
      } else {
        top2Labels.push(`${s.name} (+20%)`);
      }
    });
    const shadowC = SimEngine.shadowSimulate(overridesC, 120);

    const deltaA = shadowA.throughputPerMin - currentTP;
    const deltaB = shadowB.throughputPerMin - currentTP;
    const deltaC = shadowC.throughputPerMin - currentTP;

    // ---- Pick best scenario ----
    const bestDelta = Math.max(deltaA, deltaB, deltaC);
    let bestLabel, bestShadow, bestDesc;
    if (bestDelta === deltaA) {
      bestLabel = scenarioAName;
      bestShadow = shadowA;
      bestDesc = scenarioADesc;
    } else if (bestDelta === deltaB) {
      bestLabel = `Reduce cycle time at ${bn.name} by 20%`;
      bestShadow = shadowB;
      bestDesc = `cycle time ${bn.cycleTime}s → ${(bn.cycleTime * 0.8).toFixed(1)}s`;
    } else {
      bestLabel = `Capacity intervention on top-2 constrained stages`;
      bestShadow = shadowC;
      bestDesc = top2Labels.join(' & ');
    }

    const pctImprovement = currentTP > 0 ? ((bestDelta / currentTP) * 100) : 0;

    // ---- Build ceiling warning string ----
    let ceilingWarning = null;
    if (atCeiling) {
      ceilingWarning = `${bn.name} is already at 100% capacity — a +20% boost is impossible without adding hardware. Scenario A models a parallel machine instead.`;
    } else if (partialHeadroom) {
      ceilingWarning = `${bn.name} has only ${((CAP_CEILING - bn.capacity) * 100).toFixed(0)}pp of capacity headroom remaining — full +20% boost not achievable without additional hardware.`;
    }

    lastResult = {
      ready: true,
      bottleneckName: bn.name,
      bottleneckUtil: bn.utilization,
      bottleneckBuffer: bn.buffer,
      bottleneckScore: bn.bottleneckScore,
      currentTP,
      bestLabel,
      bestDesc,
      afterTP: bestShadow.throughputPerMin,
      deltaTP: bestDelta,
      pctImprovement,
      newBottleneckName: bestShadow.newBottleneckName,
      newBottleneckUtil: bestShadow.newBottleneckUtil,
      // Ceiling-awareness metadata
      atCeiling,
      partialHeadroom,
      ceilingWarning,
      scenarios: [
        { name: scenarioAName,                          tp: shadowA.throughputPerMin, delta: deltaA, newBN: shadowA.newBottleneckName, ceiling: atCeiling || partialHeadroom },
        { name: `−20% Cycle Time → ${bn.name}`,        tp: shadowB.throughputPerMin, delta: deltaB, newBN: shadowB.newBottleneckName, ceiling: false },
        { name: `Capacity → ${top2Labels.join(' & ')}`, tp: shadowC.throughputPerMin, delta: deltaC, newBN: shadowC.newBottleneckName, ceiling: top2.some(s => ceilingAwareCapacity(s.capacity).mode !== 'boost') },
      ],
      stageUtils: bestShadow.stageUtils,
    };

    return lastResult;
  }

  function getLastResult() { return lastResult; }

  return { analyse, getLastResult };
})();


/* ============================================================
   3. RENDERER
   Reads SimEngine snapshots and updates the DOM. Zero state.
   ============================================================ */
const Renderer = (() => {

  let chart = null;
  let chartLabels = [];
  let chartData = [];
  let lastSnapshot = null;

  // ---- Build production line cards (called once on init) ----
  function buildStageCards(stages) {
    const row = document.getElementById('stage-row');
    row.innerHTML = '';
    stages.forEach((s, i) => {
      if (i > 0) {
        const conn = document.createElement('div');
        conn.className = 'stage-connector';
        conn.innerHTML = `<div class="connector-line"></div><span class="connector-arrow">▶</span>`;
        row.appendChild(conn);
      }
      const card = document.createElement('div');
      card.className = 'stage-card green';
      card.id = `stage-card-${i}`;
      card.innerHTML = `
        <div class="stage-name">${s.name}</div>
        <span class="stage-machine-icon">${s.icon}</span>
        <div class="stage-metric">Util <span id="util-${i}">0%</span></div>
        <div class="stage-metric">Buffer <span id="buf-${i}">0</span></div>
        <div class="stage-metric">Cycle <span id="ct-${i}">${s.cycleTime}s</span></div>
        <div class="util-bar-wrap"><div class="util-bar-fill" id="utilbar-${i}" style="width:0%"></div></div>
        <div class="buffer-area" id="bufarea-${i}"></div>
        <div class="buffer-count-label" id="buflabel-${i}"></div>
        <div class="stage-status-badge idle" id="status-badge-${i}">⬤ Idle</div>
      `;
      row.appendChild(card);
    });
  }

  // ---- Build utilization bars in metrics panel ----
  function buildUtilBars(stages) {
    const container = document.getElementById('util-bars-container');
    container.innerHTML = '';
    stages.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'util-row';
      row.innerHTML = `
        <div class="util-stage-label">${s.name}</div>
        <div class="util-bar-track">
          <div class="util-bar-progress" id="utilprog-${i}" style="width:0%;background:var(--green)"></div>
        </div>
        <div class="util-percent" id="utilpct-${i}">0%</div>
      `;
      container.appendChild(row);
    });
  }

  // ---- Build control sliders ----
  function buildControlSliders(stages) {
    const container = document.getElementById('stage-controls-container');
    container.innerHTML = '';
    stages.forEach((s, i) => {
      const block = document.createElement('div');
      block.className = 'stage-control-block';
      block.innerHTML = `
        <div class="stage-ctrl-header">
          <div class="stage-ctrl-name">
            <div class="ctrl-indicator green" id="ctrl-dot-${i}"></div>
            ${s.icon} ${s.name}
          </div>
          <button class="breakdown-btn" id="breakdown-btn-${i}" onclick="Controls.triggerBreakdown(${i})">
            ⚡ Breakdown
          </button>
        </div>
        <div class="slider-group">
          <div class="slider-wrap">
            <label class="slider-label">
              Cycle Time <span class="slider-val" id="ct-val-${i}">${s.cycleTime}s</span>
            </label>
            <input type="range" min="2" max="30" step="1" value="${s.cycleTime}"
              id="ct-slider-${i}" oninput="Controls.setCycleTime(${i}, this.value)">
          </div>
          <div class="slider-wrap">
            <label class="slider-label">
              Capacity <span class="slider-val" id="cap-val-${i}">${Math.round(s.capacity * 100)}%</span>
            </label>
            <input type="range" min="0" max="100" step="5" value="${Math.round(s.capacity * 100)}"
              id="cap-slider-${i}" oninput="Controls.setCapacity(${i}, this.value)">
          </div>
        </div>
      `;
      container.appendChild(block);
    });
  }

  // ---- Utility: color from utilization ----
  function colorFromUtil(util) {
    if (util >= 90) return 'var(--red)';
    if (util >= 70) return 'var(--amber)';
    return 'var(--green)';
  }

  function classFromUtil(util) {
    if (util >= 90) return 'red';
    if (util >= 70) return 'amber';
    return 'green';
  }

  // ---- Main render call, invoked every tick ----
  function render(snapshot) {
    lastSnapshot = snapshot;
    const { stages, tick, completedUnits, throughputPerMin, prevThroughputPerMin,
            bottleneckIdx, isPaused, tickHistory } = snapshot;

    // ---- Stat cards ----
    el('stat-total').textContent = completedUnits;
    const tpDisp = throughputPerMin.toFixed(1);
    el('stat-throughput').textContent = tpDisp + ' u/min';

    // Trend arrow
    const tpDelta = throughputPerMin - prevThroughputPerMin;
    const trendEl = el('stat-throughput-trend');
    if (Math.abs(tpDelta) < 0.05) {
      trendEl.textContent = '→ Stable';
      trendEl.className = 'stat-delta neutral';
    } else if (tpDelta > 0) {
      trendEl.textContent = `↑ +${tpDelta.toFixed(1)} vs prev window`;
      trendEl.className = 'stat-delta up';
    } else {
      trendEl.textContent = `↓ ${tpDelta.toFixed(1)} vs prev window`;
      trendEl.className = 'stat-delta down';
    }

    // Efficiency = avg utilization across all stages
    const avgUtil = stages.reduce((a, s) => a + s.utilization, 0) / (stages.length || 1);
    el('stat-efficiency').textContent = avgUtil.toFixed(1) + '%';

    // Bottleneck name stat card
    const bnStage = bottleneckIdx >= 0 ? stages[bottleneckIdx] : null;
    el('stat-bottleneck').textContent = bnStage ? bnStage.name : '—';

    // Tick counter (sidebar)
    el('tick-val').textContent = tick;
    el('completed-val').textContent = completedUnits;

    // Sim time
    const minutes = Math.floor(tick / 60);
    const seconds = tick % 60;
    el('sim-time').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    // ---- Stage cards ----
    stages.forEach((s, i) => {
      const card = document.getElementById(`stage-card-${i}`);
      if (!card) return;

      const util = s.utilization;
      const cls = s.breakdown ? 'red' : classFromUtil(util);
      const color = s.breakdown ? 'var(--red)' : colorFromUtil(util);

      // Card color class + bottleneck glow
      card.className = 'stage-card ' + cls + (s.isBottleneck ? ' bottleneck' : '');

      // Metrics
      const utilEl = el(`util-${i}`);
      if (utilEl) {
        utilEl.textContent = util.toFixed(1) + '%';
        utilEl.className = s.breakdown ? 'val-red' : (util >= 90 ? 'val-red' : util >= 70 ? 'val-amber' : 'val-green');
      }
      const bufEl = el(`buf-${i}`);
      if (bufEl) bufEl.textContent = s.buffer;
      const ctEl = el(`ct-${i}`);
      if (ctEl) ctEl.textContent = s.capacity > 0 ? (s.cycleTime / s.capacity).toFixed(1) + 's' : '∞';

      // Util mini bar
      const ub = el(`utilbar-${i}`);
      if (ub) {
        ub.style.width = Math.min(util, 100) + '%';
        ub.style.background = color;
      }

      // Buffer dots (max 30 visible)
      const bufArea = el(`bufarea-${i}`);
      if (bufArea) {
        const shown = Math.min(s.buffer, 30);
        const existing = bufArea.children.length;
        if (shown > existing) {
          for (let d = existing; d < shown; d++) {
            const dot = document.createElement('div');
            dot.className = 'buffer-dot';
            dot.style.background = util >= 90 ? 'var(--red)' : util >= 70 ? 'var(--amber)' : 'var(--accent)';
            bufArea.appendChild(dot);
          }
        } else if (shown < existing) {
          for (let d = existing - 1; d >= shown; d--) {
            if (bufArea.children[d]) bufArea.removeChild(bufArea.children[d]);
          }
        }
        // Update dot colors if utilization changed
        Array.from(bufArea.children).forEach(dot => {
          dot.style.background = util >= 90 ? 'var(--red)' : util >= 70 ? 'var(--amber)' : 'var(--accent)';
        });
      }
      const bufLabel = el(`buflabel-${i}`);
      if (bufLabel) bufLabel.textContent = s.buffer > 30 ? `+${s.buffer - 30} more` : '';

      // Status badge
      const badge = el(`status-badge-${i}`);
      if (badge) {
        let statusText, statusCls;
        if (s.breakdown) {
          statusText = '⚠ Breakdown'; statusCls = 'breakdown';
        } else if (s.status === 'processing') {
          statusText = '⬤ Running'; statusCls = 'processing';
        } else if (s.status === 'starved') {
          statusText = '◯ Starved'; statusCls = 'starved';
        } else if (s.status === 'blocked') {
          statusText = '■ Blocked'; statusCls = 'blocked';
        } else {
          statusText = '◎ Idle'; statusCls = 'idle';
        }
        badge.textContent = statusText;
        badge.className = 'stage-status-badge ' + statusCls;
      }

      // Control panel dot
      const ctrlDot = el(`ctrl-dot-${i}`);
      if (ctrlDot) ctrlDot.className = 'ctrl-indicator ' + cls;

      // Util bars in metrics panel
      const utilProg = el(`utilprog-${i}`);
      if (utilProg) {
        utilProg.style.width = Math.min(util, 100) + '%';
        utilProg.style.background = color;
      }
      const utilPct = el(`utilpct-${i}`);
      if (utilPct) {
        utilPct.textContent = util.toFixed(1) + '%';
        utilPct.style.color = color;
      }
    });

    // ---- Bottleneck callout ----
    if (bnStage) {
      el('bn-name').textContent = bnStage.name;
      const reason = buildBnReason(bnStage, stages);
      el('bn-reason').textContent = reason;
      const chips = el('bn-evidence');
      chips.innerHTML = `
        <span class="evidence-chip">Util: ${bnStage.utilization.toFixed(1)}%</span>
        <span class="evidence-chip">Buffer: ${bnStage.buffer} units</span>
        <span class="evidence-chip">Score: ${(bnStage.bottleneckScore * 100).toFixed(0)}</span>
        <span class="evidence-chip">Eff. Cycle: ${bnStage.capacity > 0 ? (bnStage.cycleTime / bnStage.capacity).toFixed(1) + 's' : '∞'}</span>
      `;
    } else {
      el('bn-name').textContent = '—';
      el('bn-reason').textContent = 'No bottleneck detected yet.';
    }

    // ---- Throughput live number ----
    el('tp-live-number').textContent = throughputPerMin.toFixed(1);
    const trendBig = el('tp-trend-big');
    if (Math.abs(tpDelta) < 0.05) {
      trendBig.textContent = '→ Stable';
      trendBig.className = 'throughput-trend flat';
    } else if (tpDelta > 0) {
      trendBig.textContent = `↑ +${tpDelta.toFixed(2)} vs prev`;
      trendBig.className = 'throughput-trend up';
    } else {
      trendBig.textContent = `↓ ${tpDelta.toFixed(2)} vs prev`;
      trendBig.className = 'throughput-trend down';
    }

    // ---- Chart update ----
    updateChart(tickHistory);

    // ---- Pause/Resume button ----
    const pauseBtn = el('pause-btn');
    if (pauseBtn) pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  }

  function buildBnReason(bn, stages) {
    const parts = [];
    if (bn.utilization >= 85) parts.push(`high utilization at ${bn.utilization.toFixed(0)}%`);
    if (bn.buffer >= 5)       parts.push(`buffer queue of ${bn.buffer} units waiting`);
    if (bn.capacity < 0.8)    parts.push(`reduced capacity at ${(bn.capacity * 100).toFixed(0)}%`);
    const eff = bn.capacity > 0 ? (bn.cycleTime / bn.capacity) : Infinity;
    const maxCT = Math.max(...stages.map(s => s.capacity > 0 ? s.cycleTime / s.capacity : 0));
    if (eff >= maxCT * 0.9 && maxCT > 0) parts.push(`slowest effective cycle time (${eff.toFixed(1)}s)`);
    return parts.length ? parts.join(', ') + '.' : `Bottleneck score ${(bn.bottleneckScore * 100).toFixed(0)}/100.`;
  }

  // ---- Chart ----
  function initChart() {
    const ctx = document.getElementById('throughput-chart');
    if (!ctx) return;

    if (typeof Chart === 'undefined') {
      ctx.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:0.75rem;text-align:center;padding:20px">Chart.js not loaded — rest of app is fully functional.</div>';
      return;
    }

    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Throughput (u/min)',
          data: [],
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0,212,255,0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        scales: {
          x: {
            display: true,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#475569', font: { size: 10 }, maxTicksLimit: 8 },
          },
          y: {
            display: true,
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#475569', font: { size: 10 } },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a2235',
            borderColor: 'rgba(0,212,255,0.3)',
            borderWidth: 1,
            titleColor: '#f1f5f9',
            bodyColor: '#94a3b8',
          },
        },
      },
    });
  }

  function updateChart(tickHistory) {
    if (!chart || !tickHistory.length) return;
    const last60 = tickHistory.slice(-80);
    chart.data.labels = last60.map(h => `T${h.tick}`);
    chart.data.datasets[0].data = last60.map(h => h.throughput.toFixed(2));
    chart.update('none');
  }

  // ---- Recommendation panel ----
  function renderRecommendation(rec) {
    const panel = el('rec-content');
    if (!panel) return;

    if (!rec || !rec.ready) {
      panel.innerHTML = `<div style="color:var(--text-muted);font-size:0.78rem">${rec ? rec.reason : 'Analysing...'}</div>`;
      return;
    }

    const pct = rec.pctImprovement;
    const sign = pct >= 0 ? '+' : '';
    const deltaSign = rec.deltaTP >= 0 ? '+' : '';

    // Ceiling warning banner — shown when the bottleneck is at or near 100% capacity
    const ceilingBanner = rec.ceilingWarning
      ? `<div style="
            display:flex;align-items:flex-start;gap:8px;
            margin-bottom:12px;
            padding:10px 12px;
            background:rgba(245,158,11,0.08);
            border:1px solid rgba(245,158,11,0.3);
            border-left:4px solid var(--amber);
            border-radius:var(--radius-sm);
            font-size:0.72rem;color:var(--amber);line-height:1.5">
          <span style="font-size:1rem;flex-shrink:0">⚠</span>
          <span><strong>Capacity Ceiling Reached</strong><br>${rec.ceilingWarning}</span>
        </div>`
      : '';

    panel.innerHTML = `
      ${ceilingBanner}

      <div class="rec-body">
        <strong style="color:var(--text-primary)">🎯 ${rec.bestLabel}</strong>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">${rec.bestDesc}</div>
      </div>

      <div class="rec-comparison">
        <div class="rec-box">
          <div class="rec-box-label">Current State</div>
          <div class="rec-box-throughput">${rec.currentTP.toFixed(1)}</div>
          <div class="rec-box-sub">u/min — ${rec.bottleneckName} at ${rec.bottleneckUtil.toFixed(0)}% util, ${rec.bottleneckBuffer} units in buffer</div>
        </div>
        <div class="rec-arrow">→</div>
        <div class="rec-box after">
          <div class="rec-box-label">After Intervention</div>
          <div class="rec-box-throughput">${rec.afterTP.toFixed(1)}</div>
          <div class="rec-box-sub">u/min — new bottleneck: ${rec.newBottleneckName || '—'} at ${rec.newBottleneckUtil ? rec.newBottleneckUtil.toFixed(0) : '—'}%</div>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div class="rec-improvement">↑ ${sign}${pct.toFixed(1)}% throughput improvement (${deltaSign}${rec.deltaTP.toFixed(1)} u/min)</div>
        ${rec.newBottleneckName ? `<div class="rec-new-bottleneck">⚠ Next constraint: ${rec.newBottleneckName} (${rec.newBottleneckUtil?.toFixed(0)}% util)</div>` : ''}
      </div>

      <div class="rec-next-steps">
        <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;font-weight:700">Scenario Comparison (Shadow Simulations)</div>
        <table class="scenario-table">
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Predicted TP (u/min)</th>
              <th>Delta</th>
              <th>New Bottleneck</th>
            </tr>
          </thead>
          <tbody>
            ${rec.scenarios.map(sc => {
              const d = sc.delta;
              const dSign = d >= 0 ? '+' : '';
              const dColor = d >= 0 ? 'var(--green)' : 'var(--red)';
              // Ceiling tag: amber pill shown when this scenario required hardware escalation
              const ceilTag = sc.ceiling
                ? `<span style="
                      margin-left:5px;
                      font-size:0.58rem;padding:1px 5px;
                      background:rgba(245,158,11,0.15);
                      border:1px solid rgba(245,158,11,0.35);
                      border-radius:100px;
                      color:var(--amber);font-weight:700;
                      vertical-align:middle">⚠ CEILING</span>`
                : '';
              return `<tr>
                <td class="td-name">${sc.name}${ceilTag}</td>
                <td class="mono">${sc.tp.toFixed(1)}</td>
                <td style="color:${dColor};font-weight:700;font-family:JetBrains Mono,monospace">${dSign}${d.toFixed(1)}</td>
                <td style="color:var(--amber)">${sc.newBN || '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ---- Helpers ----
  function el(id) { return document.getElementById(id); }

  return { buildStageCards, buildUtilBars, buildControlSliders, initChart, render, renderRecommendation };
})();


/* ============================================================
   4. CONTROLS
   Wires UI controls to SimEngine mutations.
   ============================================================ */
const Controls = (() => {

  function setCycleTime(stageIdx, value) {
    const v = parseFloat(value);
    SimEngine.setStageParam(stageIdx, 'cycleTime', v);
    const el = document.getElementById(`ct-val-${stageIdx}`);
    if (el) el.textContent = v + 's';
  }

  function setCapacity(stageIdx, value) {
    const v = parseFloat(value) / 100;
    SimEngine.setStageParam(stageIdx, 'capacity', v);
    const el = document.getElementById(`cap-val-${stageIdx}`);
    if (el) el.textContent = Math.round(v * 100) + '%';
    // Sync slider
    const slider = document.getElementById(`cap-slider-${stageIdx}`);
    if (slider && slider.value !== String(value)) slider.value = value;
  }

  function triggerBreakdown(stageIdx) {
    SimEngine.triggerBreakdown(stageIdx, 25);
    const btn = document.getElementById(`breakdown-btn-${stageIdx}`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⚠ Breaking...';
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '⚡ Breakdown';
      }, 25 * 200 + 500);
    }
    App.showToast(`⚠ Breakdown triggered on Stage ${stageIdx + 1}!`, 'warning');
  }

  function setSpeed(ms, btn) {
    SimEngine.setSpeed(ms);
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
  }

  function reset() {
    SimEngine.init();
    // Re-sync sliders to defaults
    const stages = SimEngine.getDefaultStages();
    stages.forEach((s, i) => {
      const ctSlider = document.getElementById(`ct-slider-${i}`);
      const capSlider = document.getElementById(`cap-slider-${i}`);
      const ctVal = document.getElementById(`ct-val-${i}`);
      const capVal = document.getElementById(`cap-val-${i}`);
      if (ctSlider) ctSlider.value = s.cycleTime;
      if (capSlider) capSlider.value = Math.round(s.capacity * 100);
      if (ctVal) ctVal.textContent = s.cycleTime + 's';
      if (capVal) capVal.textContent = Math.round(s.capacity * 100) + '%';
    });
    SimEngine.start();
    App.showToast('🔄 Simulation reset to defaults.', 'success');
  }

  // ---- Preset: Normal Shift ----
  function presetNormal() {
    SimEngine.init();
    SimEngine.start();
    // Sync sliders
    const stages = SimEngine.getDefaultStages();
    stages.forEach((s, i) => {
      const ctSlider = document.getElementById(`ct-slider-${i}`);
      const capSlider = document.getElementById(`cap-slider-${i}`);
      const ctVal = document.getElementById(`ct-val-${i}`);
      const capVal = document.getElementById(`cap-val-${i}`);
      if (ctSlider) ctSlider.value = s.cycleTime;
      if (capSlider) capSlider.value = Math.round(s.capacity * 100);
      if (ctVal) ctVal.textContent = s.cycleTime + 's';
      if (capVal) capVal.textContent = Math.round(s.capacity * 100) + '%';
    });
    App.showToast('✅ Preset: Normal Shift loaded.', 'success');
  }

  // ---- Preset: Machine Failure ----
  function presetMachineFailure() {
    presetNormal();
    // After 4 seconds, trigger breakdown on pre-identified bottleneck (Welding = index 2)
    setTimeout(() => {
      SimEngine.triggerBreakdown(2, 40);
      const btn = document.getElementById(`breakdown-btn-2`);
      if (btn) {
        btn.disabled = true;
        setTimeout(() => { btn.disabled = false; btn.innerHTML = '⚡ Breakdown'; }, 40 * 200 + 500);
      }
      App.showToast('🔥 Machine Failure triggered on Welding (auto-preset)!', 'error');
    }, 4000);
    App.showToast('⚙ Preset: Machine Failure — breakdown incoming in 4s...', 'warning');
  }

  // ---- Preset: Rush Order ----
  function presetRushOrder() {
    SimEngine.init();
    // Lower all cycle times by 30% to simulate rush
    const stages = SimEngine.getDefaultStages();
    stages.forEach((s, i) => {
      const rushCT = Math.max(2, Math.round(s.cycleTime * 0.7));
      SimEngine.setStageParam(i, 'cycleTime', rushCT);
      SimEngine.setStageParam(i, 'capacity', 1.0);
      const ctSlider = document.getElementById(`ct-slider-${i}`);
      const ctVal = document.getElementById(`ct-val-${i}`);
      const capSlider = document.getElementById(`cap-slider-${i}`);
      const capVal = document.getElementById(`cap-val-${i}`);
      if (ctSlider) ctSlider.value = rushCT;
      if (ctVal) ctVal.textContent = rushCT + 's';
      if (capSlider) capSlider.value = 100;
      if (capVal) capVal.textContent = '100%';
    });
    SimEngine.start();
    App.showToast('🚀 Preset: Rush Order — all cycle times reduced 30%!', 'success');
  }

  return { setCycleTime, setCapacity, triggerBreakdown, setSpeed, reset,
           presetNormal, presetMachineFailure, presetRushOrder };
})();


/* ============================================================
   5. APP — Top-level init, tabs, recommendation timer
   ============================================================ */
const App = (() => {

  let recTimer = null;
  let toastTimer = null;

  function init() {
    const snapshot = SimEngine.getSnapshot();

    // Build DOM components with initial stage data
    Renderer.buildStageCards(SimEngine.getDefaultStages());
    Renderer.buildUtilBars(SimEngine.getDefaultStages());
    Renderer.buildControlSliders(SimEngine.getDefaultStages());
    Renderer.initChart();

    // Start simulation
    SimEngine.start();

    // Wire tick callback
    SimEngine.onTick(snapshot => {
      Renderer.render(snapshot);
    });

    // Tab system
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Nav sidebar items
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        const tab = item.dataset.tab;
        if (tab) switchTab(tab);
      });
    });

    // Pause button
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        const snap = SimEngine.getSnapshot();
        if (snap.isPaused) SimEngine.resume();
        else SimEngine.pause();
      });
    }

    // Reset button
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', Controls.reset);

    // Recommendation timer: run analysis every 5 seconds
    recTimer = setInterval(() => {
      const snap = SimEngine.getSnapshot();
      const rec = RecommendationEngine.analyse(snap);
      Renderer.renderRecommendation(rec);
    }, 5000);

    // Initial recommendation run at 3s
    setTimeout(() => {
      const snap = SimEngine.getSnapshot();
      const rec = RecommendationEngine.analyse(snap);
      Renderer.renderRecommendation(rec);
    }, 3000);

    // On-demand rec button
    const recBtn = document.getElementById('rec-refresh-btn');
    if (recBtn) {
      recBtn.addEventListener('click', () => {
        recBtn.classList.add('spinning');
        recBtn.querySelector('.rec-icon').textContent = '↻';
        setTimeout(() => {
          const snap = SimEngine.getSnapshot();
          const rec = RecommendationEngine.analyse(snap);
          Renderer.renderRecommendation(rec);
          recBtn.classList.remove('spinning');
          recBtn.querySelector('.rec-icon').textContent = '↻';
        }, 600);
      });
    }

    // How-it-works toggle
    const howHeader = document.getElementById('how-header');
    const howBody   = document.getElementById('how-body');
    const howChev   = document.getElementById('how-chevron');
    if (howHeader) {
      howHeader.addEventListener('click', () => {
        const open = howBody.classList.toggle('open');
        howChev.classList.toggle('open', open);
      });
    }

    // Live clock
    setInterval(() => {
      const now = new Date();
      const el = document.getElementById('topbar-clock');
      if (el) el.textContent = now.toLocaleTimeString();
    }, 1000);
  }

  function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('active', p.id === 'tab-' + tabId));
  }

  function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast ' + type + ' show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 3500);
  }

  return { init, showToast, switchTab };
})();

// ---- Boot ----
window.addEventListener('DOMContentLoaded', App.init);
