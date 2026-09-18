/**
 * BOTTLENECK ROOT-CAUSE ENGINE — rootCauseEngine.js
 * ==================================================
 * Isolated additive module. Zero modifications to existing code.
 *
 * Reads live factory state ONLY via SimEngine.getSnapshot().
 *
 * Capabilities:
 *   1. WHICH machine is the bottleneck
 *   2. WHY it became the bottleneck (Primary, Secondary, Contributing factors)
 *   3. WHAT factors caused it (Capacity, Utilization, Cycle Time, Queue, Downtime)
 *   4. HOW strongly it affects production (Throughput gap, Line ceiling, WIP penalty)
 *   5. WHAT downstream effects it creates (Starvation, Idle propagation)
 *   6. WHAT actions could potentially reduce the bottleneck (Prioritized recommendations)
 *
 * Transparency:
 *   - Mathematical & rule-based deterministic calculations.
 *   - Transparent "Rule-Based Root-Cause Contribution" scores (no fake ML).
 *   - Interactive "WHY IS THIS A BOTTLENECK?" modal with mathematical proof.
 */
'use strict';

const RootCauseEngine = (() => {

  let _lastAnalysis = null;

  /* ============================================================
     CORE MATHEMATICAL ANALYSIS ENGINE
     Pure function — takes snapshot, returns structured analysis
     ============================================================ */
  function analyze(snapshot) {
    if (!snapshot || !snapshot.stages || snapshot.stages.length === 0) {
      return null;
    }

    const { stages, bottleneckIdx, tick, throughputPerMin } = snapshot;

    // Identify bottleneck stage
    let bnIdx = bottleneckIdx;
    if (bnIdx < 0 || bnIdx >= stages.length) {
      // Fallback: pick highest utilization or bottleneckScore
      let topVal = -1;
      stages.forEach((s, i) => {
        const val = s.bottleneckScore !== undefined ? s.bottleneckScore : s.utilization;
        if (val > topVal) { topVal = val; bnIdx = i; }
      });
      if (bnIdx < 0) bnIdx = 0;
    }

    const bnStage = stages[bnIdx];
    const maxBufferInLine = Math.max(...stages.map(s => s.buffer || 0), 1);

    // Compute effective cycle times and rates for all stages
    const enrichedStages = stages.map((s, idx) => {
      const cap = s.capacity > 0 ? s.capacity : 0;
      const effCT = cap > 0 ? (s.cycleTime / cap) : Infinity;
      const ratePerMin = cap > 0 ? (60 / effCT) : 0;
      const ratePerHour = ratePerMin * 60;
      return {
        ...s,
        idx,
        effCT,
        ratePerMin,
        ratePerHour,
      };
    });

    const currentBn = enrichedStages[bnIdx];
    const avgLineCT = enrichedStages.reduce((a, s) => a + (isFinite(s.effCT) ? s.effCT : s.cycleTime), 0) / (enrichedStages.length || 1);

    // Upstream stage & incoming arrival rate calculation
    let upstreamStage = null;
    let incomingRatePerHour = 0;
    let incomingRatePerMin = 0;

    if (bnIdx === 0) {
      // First stage: incoming rate is its nominal processing rate from infinite raw feeder
      incomingRatePerHour = currentBn.ratePerHour;
      incomingRatePerMin = currentBn.ratePerMin;
    } else {
      upstreamStage = enrichedStages[bnIdx - 1];
      // Incoming rate is upstream stage's output capability
      incomingRatePerHour = upstreamStage.ratePerHour;
      incomingRatePerMin = upstreamStage.ratePerMin;
    }

    // Downstream stage calculation
    let downstreamStage = null;
    let downstreamCapacityPerHour = 0;
    let downstreamStarvationGap = 0;

    if (bnIdx < enrichedStages.length - 1) {
      downstreamStage = enrichedStages[bnIdx + 1];
      downstreamCapacityPerHour = downstreamStage.ratePerHour;
      downstreamStarvationGap = Math.max(0, downstreamCapacityPerHour - currentBn.ratePerHour);
    }

    // Capacity Gap
    const capacityGapPerHour = Math.max(0, incomingRatePerHour - currentBn.ratePerHour);
    const capacityGapPerMin = capacityGapPerHour / 60;

    // Queue growth rate (units per hour)
    const queueGrowthPerHour = capacityGapPerHour;

    // Theoretical maximum line capacity (governed by the slowest stage in line)
    const minStageRatePerHour = Math.min(...enrichedStages.map(s => s.ratePerHour));
    const maxStageRatePerHour = Math.max(...enrichedStages.map(s => s.ratePerHour));
    const lineLostProductionPerHour = Math.max(0, maxStageRatePerHour - minStageRatePerHour);

    // ------------------------------------------------------------
    // RULE-BASED ROOT-CAUSE CONTRIBUTION SCORES (0 - 100%)
    // Deterministic mathematical formulas from real operational data
    // ------------------------------------------------------------

    // 1. Capacity Constraint Score
    let capacityScore = 0;
    if (incomingRatePerHour > 0) {
      const capRatio = incomingRatePerHour / (currentBn.ratePerHour || 1);
      if (capRatio >= 1.0) {
        capacityScore = Math.min(100, Math.round(70 + (capRatio - 1.0) * 40));
      } else {
        capacityScore = Math.min(65, Math.round(capRatio * 65));
      }
    }

    // 2. High Utilization Score
    const utilScore = Math.min(100, Math.max(0, Math.round(currentBn.utilization)));

    // 3. Queue Growth / WIP Pressure Score
    let queueScore = 0;
    if (currentBn.buffer > 0) {
      queueScore = Math.min(100, Math.round(20 + (currentBn.buffer / Math.max(10, maxBufferInLine)) * 80));
    } else if (capacityGapPerHour > 0) {
      queueScore = Math.min(80, Math.round((capacityGapPerHour / (currentBn.ratePerHour || 1)) * 80));
    } else {
      queueScore = 15;
    }

    // 4. Processing Time Disparity Score
    let procTimeScore = 0;
    if (avgLineCT > 0 && isFinite(currentBn.effCT)) {
      const ctRatio = currentBn.effCT / avgLineCT;
      procTimeScore = Math.min(100, Math.round(ctRatio * 65));
    }

    // 5. Equipment Downtime / Reliability Score
    let downtimeScore = 0;
    if (currentBn.breakdown || currentBn.status === 'breakdown') {
      downtimeScore = 100;
    } else {
      const totalActiveTicks = (currentBn.utilizationTicks || 0) + (currentBn.idleTicks || 0);
      if (totalActiveTicks > 0) {
        const idleRatio = (currentBn.idleTicks || 0) / totalActiveTicks;
        downtimeScore = Math.min(100, Math.round(idleRatio * 85));
      }
    }

    const contributionScores = [
      { name: 'Capacity Constraint', score: capacityScore, color: 'var(--red)', label: `${capacityScore}%` },
      { name: 'High Utilization', score: utilScore, color: 'var(--amber)', label: `${utilScore}%` },
      { name: 'Queue Growth / WIP Accumulation', score: queueScore, color: 'var(--red)', label: `${queueScore}%` },
      { name: 'Processing Time Disparity', score: procTimeScore, color: 'var(--accent)', label: `${procTimeScore}%` },
      { name: 'Downtime / Reliability Factor', score: downtimeScore, color: downtimeScore > 50 ? 'var(--red)' : 'var(--text-muted)', label: `${downtimeScore}%` }
    ];

    // ------------------------------------------------------------
    // STRUCTURED CAUSE BREAKDOWN (Primary, Secondary, Contributing)
    // ------------------------------------------------------------
    let primaryCause = null;
    let secondaryCause = null;
    let contributingFactor = null;

    if (currentBn.breakdown) {
      primaryCause = {
        title: 'Active Machine Breakdown / Downtime',
        type: 'primary',
        desc: `<strong>${currentBn.name}</strong> is experiencing an active breakdown. Machine capacity is halted (0 units/hr), halting product transfer and immediately causing upstream accumulation.`
      };
      secondaryCause = {
        title: 'Queue Growth & Flow Interruption',
        type: 'secondary',
        desc: `Incoming work from upstream stages cannot be processed, building an immediate queue buffer backlog before ${currentBn.name}.`
      };
      contributingFactor = {
        title: 'Downstream Line Starvation',
        type: 'contributing',
        desc: `Downstream workstations have zero incoming supply and will rapidly exhaust their local buffers.`
      };
    } else if (capacityGapPerHour > 0) {
      primaryCause = {
        title: 'Severe Capacity Constraint',
        type: 'primary',
        desc: `Incoming feed rate is <strong>${incomingRatePerHour.toFixed(0)} units/hr</strong> (${incomingRatePerMin.toFixed(1)} u/min), but <strong>${currentBn.name}</strong> can only process <strong>${currentBn.ratePerHour.toFixed(0)} units/hr</strong> (${currentBn.ratePerMin.toFixed(1)} u/min). This produces a continuous capacity deficit of <strong>${capacityGapPerHour.toFixed(0)} units/hr</strong>.`
      };
      secondaryCause = {
        title: 'Sustained High Utilization',
        type: 'secondary',
        desc: `Operating at <strong>${currentBn.utilization.toFixed(1)}% utilization</strong> with zero idle recovery buffer. The machine is running at full mechanical limit.`
      };
      contributingFactor = {
        title: 'Processing Time Mismatch',
        type: 'contributing',
        desc: `Cycle time of <strong>${currentBn.cycleTime}s</strong> (effective: ${currentBn.effCT.toFixed(1)}s) is ${currentBn.effCT > avgLineCT ? ((currentBn.effCT / avgLineCT - 1) * 100).toFixed(0) + '% higher than' : 'limiting'} the line average takt pace of ${avgLineCT.toFixed(1)}s.`
      };
    } else if (currentBn.utilization >= 85) {
      primaryCause = {
        title: 'Sustained Near-Maximum Utilization',
        type: 'primary',
        desc: `<strong>${currentBn.name}</strong> is operating at <strong>${currentBn.utilization.toFixed(1)}% utilization</strong>, functioning as the pacing constraint of the line without slack capacity to handle fluctuations.`
      };
      secondaryCause = {
        title: 'Upstream Throughput Matching Constraint',
        type: 'secondary',
        desc: `Upstream supply rate (${incomingRatePerHour.toFixed(0)} u/hr) matches machine processing rate (${currentBn.ratePerHour.toFixed(0)} u/hr), keeping the machine fully saturated.`
      };
      contributingFactor = {
        title: 'Queue Buffer Sensitivity',
        type: 'contributing',
        desc: `Any micro-stoppage or slight feed spike creates an immediate queue spike in front of ${currentBn.name} (${currentBn.buffer} units currently queued).`
      };
    } else {
      primaryCause = {
        title: 'Highest Relative Stage Workload',
        type: 'primary',
        desc: `<strong>${currentBn.name}</strong> has the highest relative constraint score on the line at <strong>${currentBn.utilization.toFixed(1)}% utilization</strong> and ${currentBn.buffer} queued units.`
      };
      secondaryCause = {
        title: 'Pacing Cycle Time',
        type: 'secondary',
        desc: `Cycle time of ${currentBn.cycleTime}s is the primary factor limiting faster line speed.`
      };
      contributingFactor = {
        title: 'Balanced Line State',
        type: 'contributing',
        desc: `The line is relatively well-balanced with low queue pressure across all stations.`
      };
    }

    // ------------------------------------------------------------
    // CAUSAL CHAIN NODES
    // ------------------------------------------------------------
    const causalNodes = [
      {
        badge: '01. UPSTREAM FEED',
        title: upstreamStage ? upstreamStage.name : 'Raw Feeder',
        value: `${incomingRatePerHour.toFixed(0)} u/hr`,
        sub: 'Incoming arrival rate',
        cls: ''
      },
      {
        badge: '02. BOTTLENECK STAGE',
        title: `${currentBn.icon} ${currentBn.name}`,
        value: `${currentBn.ratePerHour.toFixed(0)} u/hr`,
        sub: `Capacity (${currentBn.utilization.toFixed(0)}% util)`,
        cls: 'rc-node-bottleneck'
      },
      {
        badge: '03. CAPACITY GAP',
        title: 'Deficit Mismatch',
        value: capacityGapPerHour > 0 ? `-${capacityGapPerHour.toFixed(0)} u/hr` : 'Balanced (0)',
        sub: capacityGapPerHour > 0 ? 'Exceeds capacity' : 'Sufficient capacity',
        cls: capacityGapPerHour > 0 ? 'rc-node-gap' : ''
      },
      {
        badge: '04. QUEUE ACCUMULATION',
        title: 'Buffer Backlog',
        value: `${currentBn.buffer} units`,
        sub: capacityGapPerHour > 0 ? `+${queueGrowthPerHour.toFixed(0)} u/hr WIP growth` : 'Stable queue',
        cls: currentBn.buffer > 10 ? 'rc-node-bottleneck' : ''
      },
      {
        badge: '05. DOWNSTREAM IMPACT',
        title: downstreamStage ? downstreamStage.name : 'Shipping',
        value: downstreamStarvationGap > 0 ? `-${downstreamStarvationGap.toFixed(0)} u/hr` : 'Fed Normally',
        sub: downstreamStage ? `Starved ${((downstreamStage.starvedTicks || 0) / Math.max(1, tick) * 100).toFixed(0)}% ticks` : 'Line output',
        cls: downstreamStarvationGap > 0 ? 'rc-node-impact' : ''
      },
      {
        badge: '06. FACTORY THROUGHPUT',
        title: 'Overall Line Cap',
        value: `${(throughputPerMin * 60).toFixed(0)} u/hr`,
        sub: `${throughputPerMin.toFixed(1)} units/min live`,
        cls: 'rc-node-impact'
      }
    ];

    // ------------------------------------------------------------
    // MACHINE CONSTRAINT COMPARISON MATRIX
    // ------------------------------------------------------------
    const machineMatrix = enrichedStages.map(s => {
      const isBn = (s.idx === bnIdx);
      let statusText = 'Normal';
      let statusCls = 'rc-st-ok';

      if (s.breakdown) {
        statusText = 'Breakdown';
        statusCls = 'rc-st-bn';
      } else if (isBn) {
        statusText = 'Bottleneck';
        statusCls = 'rc-st-bn';
      } else if (s.utilization >= 85) {
        statusText = 'Warning';
        statusCls = 'rc-st-warn';
      } else if (s.status === 'starved' || (s.starvedTicks / Math.max(1, tick)) > 0.3) {
        statusText = 'Starved';
        statusCls = 'rc-st-starved';
      }

      // Technical Constraint Score (0 - 100)
      const cScore = Math.min(100, Math.round(
        (s.utilization * 0.5) +
        ((s.buffer / Math.max(15, maxBufferInLine)) * 30) +
        (isBn ? 20 : 0)
      ));

      return {
        ...s,
        isBottleneck: isBn,
        statusText,
        statusCls,
        constraintScore: cScore,
      };
    });

    // Technical Constraint Ranking (sorted desc)
    const constraintRanking = [...machineMatrix].sort((a, b) => b.constraintScore - a.constraintScore);

    // ------------------------------------------------------------
    // ACTIONABLE RECOMMENDATIONS
    // ------------------------------------------------------------
    const recommendations = [
      {
        icon: '⚡',
        title: `Increase ${currentBn.name} Capacity (+25% to +50%)`,
        desc: `Boosting capacity from <strong>${(currentBn.capacity * 100).toFixed(0)}%</strong> to <strong>${Math.min(200, (currentBn.capacity + 0.25) * 100).toFixed(0)}%</strong> eliminates the ${capacityGapPerHour.toFixed(0)} units/hr capacity gap. Achieved via dual operator staffing, shift extension, or auxiliary feed automation.`
      },
      {
        icon: '⏱️',
        title: `Reduce ${currentBn.name} Cycle Time (-20% via SMED)`,
        desc: `Reducing processing cycle time from <strong>${currentBn.cycleTime}s</strong> down to <strong>${(currentBn.cycleTime * 0.8).toFixed(1)}s</strong> increases throughput by ~25% without capital machinery acquisition. Target jig loading and tool changeover.`
      },
      {
        icon: '🔀',
        title: `Deploy Parallel Machine at ${currentBn.name}`,
        desc: `Adding a secondary parallel unit at this station doubles processing rate to <strong>${(currentBn.ratePerHour * 2).toFixed(0)} units/hr</strong>, completely removing this workstation as a production constraint.`
      },
      {
        icon: '⚖️',
        title: `Pace Upstream Feeding (${upstreamStage ? upstreamStage.name : 'Raw Feeder'})`,
        desc: `Throttle or rebalance upstream release to match ${currentBn.name}'s effective intake pace (${currentBn.ratePerHour.toFixed(0)} u/hr). Eliminates runaway WIP queue growth (+${queueGrowthPerHour.toFixed(0)} u/hr) and reduces inventory holding costs.`
      }
    ];

    // Dynamic Plain-English Narrative for [WHY IS THIS A BOTTLENECK?]
    const whyExplanation = `
      <p><strong>${currentBn.name}</strong> is the active line bottleneck because its effective processing capacity is <strong>${currentBn.ratePerHour.toFixed(0)} units/hour</strong> (${currentBn.ratePerMin.toFixed(1)} u/min), while work arrives from upstream at <strong>${incomingRatePerHour.toFixed(0)} units/hour</strong>.</p>
      <p>This structural imbalance generates a <strong>capacity deficit of ${capacityGapPerHour.toFixed(0)} units/hour</strong>, causing work-in-progress to accumulate in the buffer queue before ${currentBn.name} (${currentBn.buffer} units currently backed up).</p>
      <p>${downstreamStage ? `Because <strong>${downstreamStage.name}</strong> relies on output from ${currentBn.name}, it suffers from material starvation (starved ${((downstreamStage.starvedTicks || 0) / Math.max(1, tick) * 100).toFixed(0)}% of simulation ticks). Overall factory output is directly constrained to ${currentBn.name}'s maximum operating velocity.` : `Because ${currentBn.name} is the final stage, total factory output cannot exceed its processing limit.`}</p>
    `;

    return {
      tick,
      currentBn,
      bnIdx,
      upstreamStage,
      downstreamStage,
      incomingRatePerHour,
      incomingRatePerMin,
      capacityGapPerHour,
      capacityGapPerMin,
      queueGrowthPerHour,
      lineLostProductionPerHour,
      contributionScores,
      primaryCause,
      secondaryCause,
      contributingFactor,
      causalNodes,
      machineMatrix,
      constraintRanking,
      recommendations,
      whyExplanation,
    };
  }

  /* ============================================================
     RENDERER FUNCTIONS
     Write strictly to #tab-rootcause elements
     ============================================================ */
  function render(analysis) {
    if (!analysis) {
      const container = document.getElementById('rc-main-container');
      if (container) {
        container.innerHTML = `
          <div style="text-align:center;padding:60px 20px;color:var(--text-muted);font-size:0.85rem">
            <div style="font-size:2rem;margin-bottom:10px">⏳</div>
            Accumulating live operational cycles... Root-cause analysis requires at least 5 simulation ticks.
          </div>`;
      }
      return;
    }

    _lastAnalysis = analysis;
    const { currentBn, incomingRatePerHour, capacityGapPerHour, queueGrowthPerHour, lineLostProductionPerHour,
            contributionScores, primaryCause, secondaryCause, contributingFactor,
            causalNodes, machineMatrix, constraintRanking, recommendations } = analysis;

    // 1. Spotlight Card
    const spotlightEl = document.getElementById('rc-spotlight-mount');
    if (spotlightEl) {
      spotlightEl.innerHTML = `
        <div class="rc-spotlight-card">
          <div class="rc-spotlight-top">
            <div>
              <span class="rc-spotlight-badge">🔴 BOTTLENECK DETECTED</span>
              <div class="rc-spotlight-name">
                <span>${currentBn.icon}</span>
                <span>Stage ${currentBn.idx + 1}: ${currentBn.name}</span>
                <span style="font-size:0.8rem;color:var(--text-muted);font-weight:500">(Primary Line Constraint)</span>
              </div>
            </div>
            <button class="rc-why-main-btn" onclick="RootCauseEngine.showWhyModal()">
              <span>❓</span> WHY IS THIS A BOTTLENECK?
            </button>
          </div>

          <div class="rc-spotlight-metrics">
            <div class="rc-spotlight-metric-box">
              <div class="rc-metric-lbl">Live Utilization</div>
              <div class="rc-metric-val rc-red">${currentBn.utilization.toFixed(1)}%</div>
              <div class="rc-metric-sub">Sustained load</div>
            </div>
            <div class="rc-spotlight-metric-box">
              <div class="rc-metric-lbl">Processing Capacity</div>
              <div class="rc-metric-val rc-cyan">${currentBn.ratePerHour.toFixed(0)} <span style="font-size:0.65rem;color:var(--text-muted)">u/hr</span></div>
              <div class="rc-metric-sub">${currentBn.ratePerMin.toFixed(1)} units/min</div>
            </div>
            <div class="rc-spotlight-metric-box">
              <div class="rc-metric-lbl">Incoming Arrival Rate</div>
              <div class="rc-metric-val rc-amber">${incomingRatePerHour.toFixed(0)} <span style="font-size:0.65rem;color:var(--text-muted)">u/hr</span></div>
              <div class="rc-metric-sub">From upstream feeder</div>
            </div>
            <div class="rc-spotlight-metric-box">
              <div class="rc-metric-lbl">Current Queue Backlog</div>
              <div class="rc-metric-val rc-red">${currentBn.buffer} <span style="font-size:0.65rem;color:var(--text-muted)">units</span></div>
              <div class="rc-metric-sub">Waiting in buffer</div>
            </div>
            <div class="rc-spotlight-metric-box">
              <div class="rc-metric-lbl">Processing Time</div>
              <div class="rc-metric-val">${currentBn.cycleTime.toFixed(1)}s</div>
              <div class="rc-metric-sub">Cap ${(currentBn.capacity * 100).toFixed(0)}%</div>
            </div>
          </div>
        </div>`;
    }

    // 2. Causes List
    const causesEl = document.getElementById('rc-causes-mount');
    if (causesEl) {
      causesEl.innerHTML = `
        <div class="rc-causes-list">
          <div class="rc-cause-card rc-primary-cause">
            <div class="rc-cause-type rc-primary">🔴 Primary Root Cause</div>
            <div class="rc-cause-headline">${primaryCause.title}</div>
            <div class="rc-cause-desc">${primaryCause.desc}</div>
          </div>

          <div class="rc-cause-card rc-secondary-cause">
            <div class="rc-cause-type rc-secondary">🟠 Secondary Factor</div>
            <div class="rc-cause-headline">${secondaryCause.title}</div>
            <div class="rc-cause-desc">${secondaryCause.desc}</div>
          </div>

          <div class="rc-cause-card rc-contributing-cause">
            <div class="rc-cause-type rc-contributing">🟡 Contributing Influence</div>
            <div class="rc-cause-headline">${contributingFactor.title}</div>
            <div class="rc-cause-desc">${contributingFactor.desc}</div>
          </div>
        </div>`;
    }

    // 3. Contribution Scores
    const scoresEl = document.getElementById('rc-scores-mount');
    if (scoresEl) {
      scoresEl.innerHTML = `
        <div class="rc-disclaimer-pill">
          ⚙ <strong>Rule-Based Root-Cause Contribution</strong><br/>
          Computed mathematically from live arrival rates, processing capacity, cycle times, and queue growth.
        </div>
        <div class="rc-scores-list">
          ${contributionScores.map(cs => `
            <div class="rc-score-item">
              <div class="rc-score-label-row">
                <span class="rc-score-name">${cs.name}</span>
                <span class="rc-score-val" style="color:${cs.color}">${cs.label}</span>
              </div>
              <div class="rc-score-track">
                <div class="rc-score-bar" style="width:${cs.score}%;background:${cs.color}"></div>
              </div>
            </div>
          `).join('')}
        </div>`;
    }

    // 4. Causal Chain Diagram
    const chainEl = document.getElementById('rc-chain-mount');
    if (chainEl) {
      const nodesHtml = causalNodes.map((n, i) => `
        <div class="rc-chain-node ${n.cls}">
          <div class="rc-node-badge">${n.badge}</div>
          <div class="rc-node-title">${n.title}</div>
          <div class="rc-node-value ${n.cls === 'rc-node-bottleneck' ? 'rc-red' : (n.cls === 'rc-node-gap' ? 'rc-amber' : '')}">${n.value}</div>
          <div class="rc-node-sub">${n.sub}</div>
        </div>
        ${i < causalNodes.length - 1 ? '<div class="rc-chain-arrow">→</div>' : ''}
      `).join('');
      chainEl.innerHTML = `<div class="rc-chain-flow">${nodesHtml}</div>`;
    }

    // 5. Impact Metrics Grid
    const impactEl = document.getElementById('rc-impact-mount');
    if (impactEl) {
      impactEl.innerHTML = `
        <div class="rc-impact-card">
          <div class="rc-impact-icon">⚡</div>
          <div class="rc-impact-label">Throughput Impact Severity</div>
          <div class="rc-impact-val ${capacityGapPerHour > 0 ? 'rc-red' : 'rc-amber'}">
            ${capacityGapPerHour > 20 ? 'HIGH' : (capacityGapPerHour > 0 ? 'MODERATE' : 'STABLE')}
          </div>
          <div class="rc-impact-sub">Capping line output at ${currentBn.ratePerHour.toFixed(0)} u/hr</div>
        </div>

        <div class="rc-impact-card">
          <div class="rc-impact-icon">⚠️</div>
          <div class="rc-impact-label">Active Capacity Deficit</div>
          <div class="rc-impact-val rc-amber">${capacityGapPerHour.toFixed(0)} <span style="font-size:0.65rem;color:var(--text-muted)">u/hr</span></div>
          <div class="rc-impact-sub">Arrivals exceed processing bandwidth</div>
        </div>

        <div class="rc-impact-card">
          <div class="rc-impact-icon">📦</div>
          <div class="rc-impact-label">Queue Accumulation Rate</div>
          <div class="rc-impact-val rc-red">+${queueGrowthPerHour.toFixed(0)} <span style="font-size:0.65rem;color:var(--text-muted)">u/hr</span></div>
          <div class="rc-impact-sub">${currentBn.buffer} units currently waiting in queue</div>
        </div>

        <div class="rc-impact-card">
          <div class="rc-impact-icon">📉</div>
          <div class="rc-impact-label">Line Capacity Opportunity Loss</div>
          <div class="rc-impact-val rc-red">-${lineLostProductionPerHour.toFixed(0)} <span style="font-size:0.65rem;color:var(--text-muted)">u/hr</span></div>
          <div class="rc-impact-sub">Potential gain if bottleneck is upgraded</div>
        </div>`;
    }

    // 6. Machine Comparison Matrix Table
    const tableEl = document.getElementById('rc-table-mount');
    if (tableEl) {
      const rowsHtml = machineMatrix.map(m => `
        <tr class="${m.isBottleneck ? 'rc-row-bottleneck' : ''}">
          <td style="font-weight:700;color:var(--text-primary)">
            ${m.icon} ${m.name} ${m.isBottleneck ? '🔴' : ''}
          </td>
          <td style="font-family:'JetBrains Mono',monospace">${m.ratePerHour.toFixed(0)} u/hr (${m.ratePerMin.toFixed(1)}/min)</td>
          <td>
            <span style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${m.utilization >= 90 ? 'var(--red)' : (m.utilization >= 75 ? 'var(--amber)' : 'var(--green)')}">
              ${m.utilization.toFixed(1)}%
            </span>
          </td>
          <td style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${m.buffer > 10 ? 'var(--red)' : 'var(--text-secondary)'}">
            ${m.buffer}
          </td>
          <td style="font-family:'JetBrains Mono',monospace">${m.cycleTime.toFixed(1)}s</td>
          <td>
            <span class="rc-status-pill ${m.statusCls}">${m.statusText}</span>
          </td>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;font-weight:700;width:24px">${m.constraintScore}</span>
              <div style="flex:1;height:6px;background:var(--bg-input);border-radius:3px;overflow:hidden;max-width:80px">
                <div style="height:100%;width:${m.constraintScore}%;background:${m.constraintScore >= 80 ? 'var(--red)' : (m.constraintScore >= 60 ? 'var(--amber)' : 'var(--accent)')}"></div>
              </div>
            </div>
          </td>
        </tr>
      `).join('');

      tableEl.innerHTML = `
        <table class="rc-table">
          <thead>
            <tr>
              <th>Machine / Stage</th>
              <th>Capacity Rate</th>
              <th>Live Utilization</th>
              <th>Queue Length</th>
              <th>Cycle Time</th>
              <th>Status</th>
              <th>Constraint Score</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>`;
    }

    // 7. Constraint Ranking List
    const rankingEl = document.getElementById('rc-ranking-mount');
    if (rankingEl) {
      rankingEl.innerHTML = `
        <div style="font-size:0.65rem;color:var(--text-muted);margin-bottom:10px">
          Technical ordering of detected constraints (not equipment quality rating).
        </div>
        <div class="rc-ranking-list">
          ${constraintRanking.map((m, rank) => `
            <div class="rc-ranking-item ${rank === 0 ? 'rc-rank-primary' : ''}">
              <div class="rc-rank-num">#${rank + 1}</div>
              <div class="rc-rank-info">
                <div class="rc-rank-name">${m.icon} ${m.name} ${rank === 0 ? '🔴 (Primary)' : ''}</div>
                <div class="rc-rank-tags">
                  Capacity: ${m.ratePerHour.toFixed(0)} u/hr &nbsp;|&nbsp;
                  Queue: ${m.buffer} units &nbsp;|&nbsp;
                  Util: ${m.utilization.toFixed(0)}%
                </div>
              </div>
              <div style="font-family:'JetBrains Mono',monospace;font-weight:800;color:${rank === 0 ? 'var(--red)' : (m.constraintScore >= 60 ? 'var(--amber)' : 'var(--text-muted)')}">
                ${m.constraintScore} pts
              </div>
            </div>
          `).join('')}
        </div>`;
    }

    // 8. Recommended Actions
    const actionsEl = document.getElementById('rc-actions-mount');
    if (actionsEl) {
      actionsEl.innerHTML = `
        <div class="rc-actions-list">
          ${recommendations.map(act => `
            <div class="rc-action-card">
              <div class="rc-action-icon">${act.icon}</div>
              <div>
                <div class="rc-action-title">${act.title}</div>
                <div class="rc-action-desc">${act.desc}</div>
              </div>
            </div>
          `).join('')}
        </div>`;
    }
  }

  /* ============================================================
     INTERACTIVE "WHY IS THIS A BOTTLENECK?" MODAL
     ============================================================ */
  function showWhyModal() {
    if (!_lastAnalysis) {
      const snap = SimEngine.getSnapshot();
      _lastAnalysis = analyze(snap);
    }
    if (!_lastAnalysis) return;

    const { currentBn, incomingRatePerHour, capacityGapPerHour, whyExplanation, upstreamStage, downstreamStage, queueGrowthPerHour } = _lastAnalysis;

    const modalDialog = document.getElementById('rc-modal-dialog');
    const modalBackdrop = document.getElementById('rc-modal-backdrop');
    if (!modalDialog || !modalBackdrop) return;

    modalDialog.innerHTML = `
      <div class="rc-modal-header">
        <div>
          <div class="rc-modal-title">
            <span>🔴 Root-Cause Explanation:</span>
            <span>${currentBn.icon} ${currentBn.name}</span>
          </div>
          <div class="rc-modal-subtitle">Mathematical derivation and causal analysis of the primary constraint</div>
        </div>
        <button class="rc-modal-close-btn" onclick="RootCauseEngine.closeWhyModal()">&times;</button>
      </div>

      <div class="rc-modal-body">
        <div class="rc-modal-narrative">
          ${whyExplanation}
        </div>

        <div class="rc-proof-box">
          <div class="rc-proof-title">📐 Mathematical Proof & Causal Derivation</div>

          <div class="rc-proof-step">
            <span class="rc-step-badge">STEP 1</span>
            <div class="rc-step-text">
              <strong>Upstream Arrival Rate (R<sub>in</sub>):</strong><br/>
              Material is delivered from ${upstreamStage ? upstreamStage.name : 'Feeder'} at <strong>${incomingRatePerHour.toFixed(0)} units/hour</strong> (${(incomingRatePerHour / 60).toFixed(1)} units/min).
            </div>
          </div>

          <div class="rc-proof-step">
            <span class="rc-step-badge">STEP 2</span>
            <div class="rc-step-text">
              <strong>Bottleneck Maximum Processing Rate (R<sub>proc</sub>):</strong><br/>
              With a cycle time of ${currentBn.cycleTime}s and capacity of ${(currentBn.capacity * 100).toFixed(0)}%, maximum throughput is calculated as:<br/>
              <code>R<sub>proc</sub> = 3600 &times; (Capacity / CycleTime) = 3600 &times; (${currentBn.capacity} / ${currentBn.cycleTime}) = <strong>${currentBn.ratePerHour.toFixed(0)} units/hour</strong></code>.
            </div>
          </div>

          <div class="rc-proof-step">
            <span class="rc-step-badge">STEP 3</span>
            <div class="rc-step-text">
              <strong>Rate Deficit & Queue Accumulation (&Delta;):</strong><br/>
              <code>&Delta; = R<sub>in</sub> &minus; R<sub>proc</sub> = ${incomingRatePerHour.toFixed(0)} &minus; ${currentBn.ratePerHour.toFixed(0)} = <strong>+${capacityGapPerHour.toFixed(0)} units/hour</strong></code>.<br/>
              Because &Delta; &gt; 0, WIP cannot clear and queues accumulate at ${queueGrowthPerHour.toFixed(0)} units/hour (current backlog: ${currentBn.buffer} units).
            </div>
          </div>

          <div class="rc-proof-step">
            <span class="rc-step-badge">STEP 4</span>
            <div class="rc-step-text">
              <strong>Downstream Starvation Propagation:</strong><br/>
              ${downstreamStage ? `Downstream <strong>${downstreamStage.name}</strong> possesses a capacity of <strong>${downstreamStage.ratePerHour.toFixed(0)} units/hour</strong>. Because it only receives ${currentBn.ratePerHour.toFixed(0)} units/hour from ${currentBn.name}, it is starved by ${Math.max(0, downstreamStage.ratePerHour - currentBn.ratePerHour).toFixed(0)} units/hour.` : `Total factory output is capped at the bottleneck rate of ${currentBn.ratePerHour.toFixed(0)} units/hour.`}
            </div>
          </div>
        </div>
      </div>

      <div class="rc-modal-footer">
        <button class="rc-refresh-btn" onclick="RootCauseEngine.closeWhyModal()">Close</button>
      </div>
    `;

    modalBackdrop.classList.add('rc-modal-open');
    document.body.style.overflow = 'hidden';
  }

  function closeWhyModal(e) {
    if (e && e.target) {
      const backdrop = document.getElementById('rc-modal-backdrop');
      if (e.target !== backdrop && !e.target.closest('.rc-modal-close-btn') && !e.target.closest('.rc-refresh-btn')) {
        return;
      }
    }
    const backdrop = document.getElementById('rc-modal-backdrop');
    if (backdrop) backdrop.classList.remove('rc-modal-open');
    document.body.style.overflow = '';
  }

  /* ============================================================
     LIFECYCLE & INITIALIZATION
     ============================================================ */
  function refresh() {
    const snap = SimEngine.getSnapshot();
    const res = analyze(snap);
    render(res);
  }

  function init() {
    // Escape key listener for modal
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeWhyModal();
    });

    // Wire live tick hook (only renders if rootcause tab is active)
    SimEngine.onTick((snapshot) => {
      const panel = document.getElementById('tab-rootcause');
      if (panel && panel.classList.contains('active')) {
        const res = analyze(snapshot);
        render(res);
      }
    });

    // Initial render
    setTimeout(() => {
      const snap = SimEngine.getSnapshot();
      const res = analyze(snap);
      render(res);
    }, 500);
  }

  return {
    init,
    refresh,
    analyze,
    showWhyModal,
    closeWhyModal,
  };

})();

// Boot on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(RootCauseEngine.init, 250);
});
