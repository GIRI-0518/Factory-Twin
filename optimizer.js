/**
 * AI WHAT-IF OPTIMIZER — optimizer.js
 * =====================================
 * Isolated additive module. Zero modifications to existing code.
 *
 * Reads live state ONLY via SimEngine.getSnapshot() and
 * SimEngine.shadowSimulate() — both existing, public, read-only APIs.
 *
 * Architecture:
 *   WhatIfOptimizer.init()            — called once after DOM ready
 *   WhatIfOptimizer.runOptimize()     — generates & simulates 5 scenarios
 *   WhatIfOptimizer.runManual()       — simulates user-defined override
 *   _generateScenarios(snapshot)      — pure function, returns scenario list
 *   _simulateScenario(sc, snapshot)   — runs shadow sim, returns result
 *   _buildAIRecommendation(results)   — rule-based AI reasoning, returns text
 *   _renderSummary(snapshot)          — updates the 4 stat cards at top
 *   _renderScenarios(results)         — builds the scenario cards grid
 *   _renderTable(results)             — builds the comparison table
 *   _renderAI(results)                — renders the AI insight block
 *   _populateManualStageSelect()      — fills the stage dropdown
 *
 * Rule-based AI engine (replaceable with a real LLM call):
 *   IF bottleneck util > 90% AND capacity headroom exists → recommend capacity boost
 *   IF bottleneck at ceiling → recommend parallel machine
 *   IF cycle-time reduction gives > 15% gain → recommend process improvement
 *   IF parallel machine scenario gives highest gain → recommend hardware addition
 *   Explains shift of bottleneck post-fix using shadow sim data.
 */
'use strict';

const WhatIfOptimizer = (() => {

  // Stored state for detail modal inspection
  let _lastResults = [];
  let _lastSnapshot = null;

  /* ============================================================
     SCENARIO GENERATORS
     Pure functions — no state mutation, no DOM access.
     Each returns: { id, title, desc, overrides }
     overrides = { [stageIdx]: { capacity, cycleTime } }
     ============================================================ */

  /**
   * Generate 5 deterministic scenarios from current snapshot.
   * Dynamically targets the actual bottleneck stage.
   */
  function _generateScenarios(snapshot) {
    const { stages, bottleneckIdx } = snapshot;
    if (!stages || stages.length === 0) return [];

    const bn = stages[bottleneckIdx] || stages[0];
    const bnIdx = bottleneckIdx >= 0 ? bottleneckIdx : 0;

    // Sorted by utilization to find 2nd most-constrained
    const byUtil = [...stages].map((s, i) => ({ ...s, _i: i }))
                               .sort((a, b) => b.utilization - a.utilization);
    const secondIdx = byUtil[1] ? byUtil[1]._i : bnIdx;
    const second    = stages[secondIdx];

    // Scenario 1 — Increase bottleneck capacity +25% (capped at 1.0, or parallel if at ceiling)
    const sc1Cap = bn.capacity >= 1.0
      ? Math.min(2.0, bn.capacity * 2)   // parallel machine model
      : Math.min(1.0, bn.capacity + 0.25);
    const sc1IsPar = bn.capacity >= 1.0;

    // Scenario 2 — Reduce bottleneck cycle time by 25%
    const sc2CT = Math.max(1, bn.cycleTime * 0.75);

    // Scenario 3 — Add parallel machine at bottleneck (always capacity * 2, max 2.0)
    const sc3Cap = Math.min(2.0, bn.capacity <= 0 ? 2.0 : bn.capacity * 2);

    // Scenario 4 — Reduce cycle time of 2nd most constrained stage by 20%
    const sc4CT = Math.max(1, second.cycleTime * 0.80);

    // Scenario 5 — Balance: equalise all effective cycle times toward the median
    //   Effective CT = cycleTime / capacity. Target = median effective CT.
    const effectiveCTs = stages.map(s => s.capacity > 0 ? s.cycleTime / s.capacity : Infinity);
    const finite = effectiveCTs.filter(v => isFinite(v)).sort((a, b) => a - b);
    const medianECT = finite[Math.floor(finite.length / 2)] || 1;
    const sc5overrides = {};
    stages.forEach((s, i) => {
      const eff = s.capacity > 0 ? s.cycleTime / s.capacity : Infinity;
      if (eff > medianECT * 1.15) {
        // This stage is slower than median — boost its capacity toward parity
        const targetCap = Math.min(1.0, (s.cycleTime / medianECT));
        if (targetCap > s.capacity + 0.05) {
          sc5overrides[i] = { capacity: Math.min(1.0, targetCap), cycleTime: s.cycleTime };
        }
      }
    });

    return [
      {
        id: 'sc1',
        title: sc1IsPar ? `Add parallel machine at ${bn.name}` : `Increase ${bn.name} capacity +25%`,
        desc: sc1IsPar
          ? `${bn.name} is already at 100% capacity. Adding a parallel machine doubles effective throughput to ${(sc1Cap * 100).toFixed(0)}%.`
          : `Raise ${bn.name} capacity from ${(bn.capacity * 100).toFixed(0)}% to ${(sc1Cap * 100).toFixed(0)}%. Targets the primary bottleneck directly.`,
        overrides: { [bnIdx]: { capacity: sc1Cap, cycleTime: bn.cycleTime } },
        stageName: bn.name,
        stageIdx: bnIdx,
      },
      {
        id: 'sc2',
        title: `Reduce ${bn.name} cycle time −25%`,
        desc: `Cut ${bn.name}'s processing time from ${bn.cycleTime}s to ${sc2CT.toFixed(1)}s per unit via process improvement or tooling upgrade.`,
        overrides: { [bnIdx]: { capacity: bn.capacity, cycleTime: sc2CT } },
        stageName: bn.name,
        stageIdx: bnIdx,
      },
      {
        id: 'sc3',
        title: `Parallel machine at ${bn.name} (×2 capacity)`,
        desc: `Add a second identical machine at ${bn.name}, doubling effective capacity to ${(sc3Cap * 100).toFixed(0)}%. Removes the bottleneck constraint entirely if capacity is the sole limiter.`,
        overrides: { [bnIdx]: { capacity: sc3Cap, cycleTime: bn.cycleTime } },
        stageName: bn.name,
        stageIdx: bnIdx,
      },
      {
        id: 'sc4',
        title: `Reduce ${second.name} cycle time −20%`,
        desc: `Process improvement at the 2nd-most constrained stage: ${second.name} from ${second.cycleTime}s → ${sc4CT.toFixed(1)}s. Prevents ${second.name} from becoming the new bottleneck after fixing ${bn.name}.`,
        overrides: { [secondIdx]: { capacity: second.capacity, cycleTime: sc4CT } },
        stageName: second.name,
        stageIdx: secondIdx,
      },
      {
        id: 'sc5',
        title: 'Balance all stage capacities',
        desc: `Lift all stages with effective cycle time >15% above the median (${medianECT.toFixed(1)}s) toward parity. Spreads investment across the line rather than focusing on one stage.`,
        overrides: Object.keys(sc5overrides).length > 0 ? sc5overrides : { [bnIdx]: { capacity: Math.min(1.0, bn.capacity + 0.10), cycleTime: bn.cycleTime } },
        stageName: 'Multiple stages',
        stageIdx: -1,
      },
    ];
  }

  /**
   * Simulate a single scenario using SimEngine.shadowSimulate().
   * Returns enriched result object with all metrics.
   */
  function _simulateScenario(sc, snapshot) {
    const result = SimEngine.shadowSimulate(sc.overrides, 120);
    const delta  = result.throughputPerMin - snapshot.throughputPerMin;
    const pct    = snapshot.throughputPerMin > 0
      ? (delta / snapshot.throughputPerMin) * 100
      : 0;

    // Avg utilization across shadow stages
    const avgUtil = result.stageUtils.reduce((a, s) => a + s.utilization, 0)
                  / (result.stageUtils.length || 1);

    // Total buffer in shadow
    const totalBuffer = result.stageUtils.reduce((a, s) => a + s.buffer, 0);

    return {
      ...sc,
      throughput: result.throughputPerMin,
      delta,
      pct,
      newBottleneck: result.newBottleneckName || '—',
      newBottleneckUtil: result.newBottleneckUtil || 0,
      avgUtil,
      totalBuffer,
      stageUtils: result.stageUtils,
    };
  }

  /* ============================================================
     RULE-BASED AI RECOMMENDATION ENGINE
     Structured so a real LLM API can replace this function later.
     Input:  results[] sorted by delta desc, snapshot
     Output: { headline, paragraphs[], rulesTriggered[] }
     ============================================================ */
  function _buildAIRecommendation(results, snapshot) {
    if (!results || results.length === 0) {
      return { headline: 'No simulation data.', paragraphs: [], rulesTriggered: [] };
    }

    const best      = results[0];
    const second    = results[1];
    const bn        = snapshot.bottleneckStage || snapshot.stages[snapshot.bottleneckIdx] || snapshot.stages[0];
    const currentTP = snapshot.throughputPerMin;
    const rulesTriggered = [];
    const paragraphs = [];

    // Rule 1 — Explain why there is a bottleneck
    const bnUtil = bn ? bn.utilization : 0;
    if (bnUtil >= 90) {
      rulesTriggered.push({ trigger: 'Bottleneck util ≥ 90%', action: 'Explain primary constraint' });
      paragraphs.push(
        `<strong>${bn.name}</strong> is the primary production constraint with <strong>${bnUtil.toFixed(0)}% utilization</strong> and ${bn.buffer} units queued in its input buffer. ` +
        `At this level of load, the stage cannot clear incoming work fast enough — every upstream stage is limited to ${bn.name}'s effective output rate of ${(60 / (bn.cycleTime / bn.capacity)).toFixed(1)} units/min.`
      );
    } else {
      rulesTriggered.push({ trigger: 'Bottleneck util < 90%', action: 'Note moderate constraint' });
      paragraphs.push(
        `<strong>${bn.name}</strong> is the current constraint at <strong>${bnUtil.toFixed(0)}% utilization</strong>. ` +
        `While not critically overloaded, it is the stage most limiting line throughput.`
      );
    }

    // Rule 2 — Best scenario explanation
    if (best.pct > 0) {
      if (best.id === 'sc3' || best.title.toLowerCase().includes('parallel')) {
        rulesTriggered.push({ trigger: 'Parallel machine scenario has highest gain', action: 'Recommend hardware addition' });
        paragraphs.push(
          `Adding a parallel machine at <strong>${bn.name}</strong> produces the largest simulated throughput improvement: ` +
          `<strong>${currentTP.toFixed(1)} → ${best.throughput.toFixed(1)} u/min (+${best.pct.toFixed(0)}%)</strong>. ` +
          `This fully removes ${bn.name} as a constraint, shifting the bottleneck to <strong>${best.newBottleneck}</strong> (${best.newBottleneckUtil.toFixed(0)}% util).`
        );
      } else if (best.id === 'sc1') {
        rulesTriggered.push({ trigger: 'Capacity increase at bottleneck has highest gain', action: 'Recommend capacity boost' });
        paragraphs.push(
          `Increasing capacity at <strong>${bn.name}</strong> is the highest-impact single intervention: ` +
          `<strong>${currentTP.toFixed(1)} → ${best.throughput.toFixed(1)} u/min (+${best.pct.toFixed(0)}%)</strong>. ` +
          `After this fix, <strong>${best.newBottleneck}</strong> becomes the next constraint at ${best.newBottleneckUtil.toFixed(0)}% utilization.`
        );
      } else if (best.id === 'sc2') {
        rulesTriggered.push({ trigger: 'Cycle-time reduction has highest gain (>15%)', action: 'Recommend process improvement' });
        paragraphs.push(
          `Reducing ${bn.name}'s processing time by 25% delivers the highest gain: ` +
          `<strong>${currentTP.toFixed(1)} → ${best.throughput.toFixed(1)} u/min (+${best.pct.toFixed(0)}%)</strong>. ` +
          `This is achievable without new hardware — tooling upgrades, kaizen events, or SOP revision at ${bn.name} are sufficient.`
        );
      } else {
        rulesTriggered.push({ trigger: 'Balanced scenario wins', action: 'Recommend line balancing' });
        paragraphs.push(
          `The highest gain comes from a balanced multi-stage intervention: <strong>+${best.pct.toFixed(0)}%</strong> throughput improvement. ` +
          `This distributes investment across the line rather than targeting a single stage.`
        );
      }
    } else {
      rulesTriggered.push({ trigger: 'All deltas ≤ 0', action: 'Warn — line is already balanced or at system limit' });
      paragraphs.push(
        `All simulated interventions at ${bn.name} produce little or no throughput gain. ` +
        `This suggests the line is already near its system-level optimum, or the bottleneck is shifting between stages rapidly. ` +
        `Consider running the optimizer again after letting the simulation stabilise.`
      );
    }

    // Rule 3 — Second-best scenario note
    if (second && second.pct > 2 && second.id !== best.id) {
      rulesTriggered.push({ trigger: 'Second scenario within 10pp of best', action: 'Present as alternative' });
      paragraphs.push(
        `As a lower-cost alternative, <strong>${second.title}</strong> delivers <strong>+${second.pct.toFixed(0)}%</strong> improvement ` +
        `(${currentTP.toFixed(1)} → ${second.throughput.toFixed(1)} u/min), which may be achievable without capital expenditure if ${second.id === 'sc2' || second.id === 'sc4' ? 'process changes are feasible' : 'spare capacity exists'}.`
      );
    }

    // Rule 4 — Warn if next bottleneck is dangerous
    if (best.newBottleneckUtil > 88) {
      rulesTriggered.push({ trigger: 'Next bottleneck util > 88% post-fix', action: 'Warn about successor constraint' });
      paragraphs.push(
        `⚠ Note: after implementing the recommended intervention, <strong>${best.newBottleneck}</strong> will immediately become a critical constraint at <strong>${best.newBottleneckUtil.toFixed(0)}% utilization</strong>. ` +
        `Plan a follow-up action at that stage to sustain the throughput gain.`
      );
    }

    return {
      headline: best.pct > 0
        ? `Recommendation: ${best.title} — predicted +${best.pct.toFixed(0)}% throughput gain`
        : `No clear improvement found — line may already be balanced`,
      paragraphs,
      rulesTriggered,
    };
  }

  /* ============================================================
     RENDERER FUNCTIONS — write only to #tab-optimizer elements
     ============================================================ */

  function _renderSummary(snapshot) {
    const { throughputPerMin, stages, bottleneckStage, bottleneckIdx } = snapshot;
    const bn = bottleneckStage || (bottleneckIdx >= 0 ? stages[bottleneckIdx] : null);
    const avgUtil = stages.reduce((a, s) => a + s.utilization, 0) / (stages.length || 1);
    const totalBuf = stages.reduce((a, s) => a + s.buffer, 0);

    const tp = throughputPerMin.toFixed(1);
    const bnName = bn ? bn.name : '—';
    const eff = avgUtil.toFixed(1) + '%';
    const effClass = avgUtil >= 90 ? 'opt-val-red' : avgUtil >= 70 ? 'opt-val-amber' : 'opt-val-green';

    const cards = [
      { icon:'⚡', label:'Current Throughput', val: tp + ' u/min', cls:'opt-val-cyan' },
      { icon:'⚠️', label:'Bottleneck Stage',   val: bnName,        cls: bn && bn.utilization >= 90 ? 'opt-val-red' : 'opt-val-amber' },
      { icon:'📊', label:'Avg Utilization',    val: eff,           cls: effClass },
      { icon:'📦', label:'Total Buffer Queue', val: totalBuf + ' units', cls: totalBuf > 30 ? 'opt-val-red' : 'opt-val-cyan' },
    ];

    const wrap = document.getElementById('opt-summary-bar');
    if (!wrap) return;
    wrap.innerHTML = cards.map(c => `
      <div class="opt-summary-card">
        <div class="opt-summary-icon">${c.icon}</div>
        <div>
          <div class="opt-summary-label">${c.label}</div>
          <div class="opt-summary-value ${c.cls}">${c.val}</div>
        </div>
      </div>`).join('');
  }

  function _renderScenarios(results, currentTP) {
    const grid = document.getElementById('opt-scenarios-grid');
    if (!grid) return;
    if (!results || results.length === 0) {
      grid.innerHTML = '<div class="opt-empty-state"><div class="opt-empty-icon">🔍</div>No scenarios generated.</div>';
      return;
    }

    // Sort by delta descending for ranking
    const sorted = [...results].sort((a, b) => b.delta - a.delta);

    grid.innerHTML = sorted.map((sc, rank) => {
      const cardCls = rank === 0 ? 'opt-best' : rank === 1 ? 'opt-second' : 'opt-other';
      const rankCls = rank === 0 ? 'opt-rank-best' : rank === 1 ? 'opt-rank-2' : 'opt-rank-other';
      const rankLabel = rank === 0 ? '🏆 Best' : rank === 1 ? '2nd' : `${rank + 1}th`;
      const sign  = sc.pct >= 0 ? '+' : '';
      const posneg = sc.pct >= 0 ? 'opt-pos' : 'opt-neg';
      const bnColor = sc.newBottleneckUtil >= 90 ? 'opt-val-red' : 'opt-val-amber';
      return `
        <div class="opt-scenario-card ${cardCls}" id="opt-card-${sc.id}">
          <span class="opt-scenario-rank ${rankCls}">${rankLabel}</span>
          <div class="opt-sc-title">${sc.title}</div>
          <div class="opt-sc-desc">${sc.desc}</div>
          <div class="opt-sc-metrics">
            <div class="opt-sc-metric">
              <div class="opt-sc-metric-label">Throughput</div>
              <div class="opt-sc-metric-val opt-neu">${sc.throughput.toFixed(1)} u/min</div>
            </div>
            <div class="opt-sc-metric">
              <div class="opt-sc-metric-label">Improvement</div>
              <div class="opt-sc-metric-val ${posneg}">${sign}${sc.pct.toFixed(1)}%</div>
            </div>
            <div class="opt-sc-metric">
              <div class="opt-sc-metric-label">New Bottleneck</div>
              <div class="opt-sc-metric-val ${bnColor}" style="font-size:0.72rem">${sc.newBottleneck}</div>
            </div>
            <div class="opt-sc-metric">
              <div class="opt-sc-metric-label">Queue (total)</div>
              <div class="opt-sc-metric-val">${sc.totalBuffer}</div>
            </div>
          </div>
          <div class="opt-sc-improvement ${posneg}">${sign}${sc.delta.toFixed(1)} u/min vs current</div>
          <button class="opt-simulate-btn" onclick="WhatIfOptimizer.showScenarioDetail('${sc.id}')">▶ View Detail</button>
        </div>`;
    }).join('');
  }

  function _renderTable(results, currentTP, snapshot) {
    const wrap = document.getElementById('opt-table-wrap');
    if (!wrap) return;
    if (!results || results.length === 0) {
      wrap.innerHTML = '<div class="opt-empty-state">Run the optimizer to generate comparison data.</div>';
      return;
    }

    const bn = snapshot.bottleneckStage || snapshot.stages[snapshot.bottleneckIdx] || snapshot.stages[0];
    const sorted = [...results].sort((a, b) => b.delta - a.delta);

    const rows = sorted.map((sc, rank) => {
      const sign = sc.pct >= 0 ? '+' : '';
      const dCls = sc.pct >= 0 ? 'opt-pos' : 'opt-neg';
      const rowCls = rank === 0 ? 'opt-row-best' : '';
      return `<tr class="${rowCls}" style="cursor:pointer" onclick="WhatIfOptimizer.showScenarioDetail('${sc.id}')" title="Click to view detailed analysis">
        <td class="opt-td-name">${rank === 0 ? '🏆 ' : ''}${sc.title}</td>
        <td class="opt-td-util">${sc.throughput.toFixed(1)} u/min</td>
        <td class="opt-td-improvement ${dCls}">${sign}${sc.pct.toFixed(1)}%</td>
        <td class="opt-td-improvement ${dCls}">${sign}${sc.delta.toFixed(1)}</td>
        <td class="opt-td-bn">${sc.newBottleneck}</td>
        <td class="opt-td-util">${sc.totalBuffer}</td>
        <td class="opt-td-util">${sc.avgUtil.toFixed(1)}%</td>
        <td>
          <button class="opt-simulate-btn" style="padding:4px 10px;font-size:0.66rem" onclick="event.stopPropagation();WhatIfOptimizer.showScenarioDetail('${sc.id}')">▶ Detail</button>
        </td>
      </tr>`;
    });

    const currentBufTotal = snapshot.stages.reduce((a, s) => a + s.buffer, 0);
    const currentAvgUtil  = snapshot.stages.reduce((a, s) => a + s.utilization, 0) / (snapshot.stages.length || 1);

    wrap.innerHTML = `
      <table class="opt-table">
        <thead><tr>
          <th>Scenario</th>
          <th>Throughput</th>
          <th>Improvement %</th>
          <th>+/- u/min</th>
          <th>New Bottleneck</th>
          <th>Queue</th>
          <th>Avg Util</th>
          <th>Action</th>
        </tr></thead>
        <tbody>
          <tr class="opt-row-current">
            <td class="opt-td-name">📍 Current State</td>
            <td>${currentTP.toFixed(1)} u/min</td>
            <td>—</td>
            <td>—</td>
            <td class="opt-td-bn">${bn ? bn.name : '—'}</td>
            <td>${currentBufTotal}</td>
            <td>${currentAvgUtil.toFixed(1)}%</td>
            <td>—</td>
          </tr>
          ${rows.join('')}
        </tbody>
      </table>`;
  }

  function _renderAI(aiResult) {
    const block = document.getElementById('opt-ai-block');
    if (!block) return;

    const rulesHtml = aiResult.rulesTriggered.map(r => `
      <div class="opt-ai-rule">
        <span class="opt-ai-rule-trigger">IF ${r.trigger}</span>
        <span style="color:var(--text-muted)">→</span>
        <span class="opt-ai-rule-action">${r.action}</span>
      </div>`).join('');

    block.innerHTML = `
      <div class="opt-ai-header">
        <span class="opt-ai-icon">🤖</span>
        <div>
          <div class="opt-ai-title">AI Recommendation</div>
          <div class="opt-ai-subtitle">Rule-based engine — ${aiResult.rulesTriggered.length} rules evaluated — ready for LLM API integration</div>
        </div>
      </div>
      <div class="opt-ai-body">
        <p><strong>${aiResult.headline}</strong></p>
        ${aiResult.paragraphs.map(p => `<p>${p}</p>`).join('')}
      </div>
      <div class="opt-ai-rules">
        <div class="opt-ai-rules-title">📋 Rules triggered this analysis</div>
        ${rulesHtml}
      </div>`;
  }

  function _populateManualStageSelect() {
    const sel = document.getElementById('opt-manual-stage');
    if (!sel) return;
    const snap = SimEngine.getSnapshot();
    sel.innerHTML = snap.stages.map((s, i) =>
      `<option value="${i}">${s.icon} ${s.name} (cap ${(s.capacity * 100).toFixed(0)}%, CT ${s.cycleTime}s)</option>`
    ).join('');
    _syncManualInputs();
  }

  function _syncManualInputs() {
    const sel = document.getElementById('opt-manual-stage');
    const capIn = document.getElementById('opt-manual-capacity');
    const ctIn  = document.getElementById('opt-manual-ct');
    if (!sel || !capIn || !ctIn) return;
    const snap = SimEngine.getSnapshot();
    const s = snap.stages[parseInt(sel.value, 10)];
    if (!s) return;
    capIn.value = Math.round(s.capacity * 100);
    ctIn.value  = s.cycleTime;
  }

  /* ============================================================
     PUBLIC API
     ============================================================ */

  /** Entry point — wires all event listeners, called after DOMContentLoaded */
  function init() {
    // Sync manual inputs when stage dropdown changes
    const sel = document.getElementById('opt-manual-stage');
    if (sel) sel.addEventListener('change', _syncManualInputs);

    // Close modal on Escape key press
    window.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeModal();
    });

    // Update summary bar whenever a tick fires
    SimEngine.onTick(function(snapshot) {
      // Only update if the optimizer tab is active (avoid unnecessary DOM work)
      const panel = document.getElementById('tab-optimizer');
      if (panel && panel.classList.contains('active')) {
        _renderSummary(snapshot);
      }
    });

    // Initial summary render
    const snap = SimEngine.getSnapshot();
    _renderSummary(snap);
    _populateManualStageSelect();
  }

  /** Run the full optimizer: generate → simulate all → render everything */
  function runOptimize() {
    const btn = document.getElementById('opt-run-btn');
    if (btn) { btn.disabled = true; btn.classList.add('opt-running'); btn.querySelector('.opt-btn-icon').textContent = '⚙'; }

    // Short delay so spinner renders before heavy computation
    setTimeout(function() {
      try {
        const snapshot  = SimEngine.getSnapshot();

        // Guard: need enough data
        if (snapshot.tick < 5) {
          _showOptError('Simulation is still starting up. Please wait a few seconds and try again.');
          if (btn) { btn.disabled = false; btn.classList.remove('opt-running'); btn.querySelector('.opt-btn-icon').textContent = '⚡'; }
          return;
        }

        const scenarios = _generateScenarios(snapshot);
        const results   = scenarios.map(sc => _simulateScenario(sc, snapshot));
        _lastResults    = results;
        _lastSnapshot   = snapshot;

        const sorted    = [...results].sort((a, b) => b.delta - a.delta);
        const aiResult  = _buildAIRecommendation(sorted, snapshot);

        _renderSummary(snapshot);
        _renderScenarios(results, snapshot.throughputPerMin);
        _renderTable(results, snapshot.throughputPerMin, snapshot);
        _renderAI(aiResult);

        // Reveal results sections
        ['opt-scenarios-section', 'opt-table-section', 'opt-ai-section'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'block';
        });

        // Re-populate stage dropdown in case stages changed
        _populateManualStageSelect();

      } catch(err) {
        _showOptError('Optimizer error: ' + err.message);
        console.error('[WhatIfOptimizer]', err);
      }

      if (btn) { btn.disabled = false; btn.classList.remove('opt-running'); btn.querySelector('.opt-btn-icon').textContent = '⚡'; }
    }, 50);
  }

  /** Run a single manual what-if simulation from the user inputs */
  function runManual() {
    const sel   = document.getElementById('opt-manual-stage');
    const capIn = document.getElementById('opt-manual-capacity');
    const ctIn  = document.getElementById('opt-manual-ct');
    const res   = document.getElementById('opt-manual-result');
    if (!sel || !capIn || !ctIn || !res) return;

    const stageIdx = parseInt(sel.value, 10);
    const newCap   = Math.max(0, Math.min(2.0, parseFloat(capIn.value) / 100));
    const newCT    = Math.max(1, parseFloat(ctIn.value));

    if (isNaN(newCap) || isNaN(newCT)) { _showOptError('Please enter valid numbers.'); return; }

    const snapshot  = SimEngine.getSnapshot();
    const current   = snapshot.throughputPerMin;
    const stageName = snapshot.stages[stageIdx] ? snapshot.stages[stageIdx].name : 'Stage ' + (stageIdx + 1);

    const overrides = { [stageIdx]: { capacity: newCap, cycleTime: newCT } };
    const shadow    = SimEngine.shadowSimulate(overrides, 120);
    const after     = shadow.throughputPerMin;
    const delta     = after - current;
    const pct       = current > 0 ? (delta / current) * 100 : 0;
    const sign      = delta >= 0 ? '+' : '';
    const deltaClass = delta >= 0 ? '' : 'opt-neg';

    res.classList.add('opt-visible');
    res.innerHTML = `
      <div class="opt-before-after">
        <div class="opt-ba-box">
          <div class="opt-ba-label">Before</div>
          <div class="opt-ba-tp">${current.toFixed(1)}</div>
          <div class="opt-ba-sub">u/min — ${stageName}: ${(snapshot.stages[stageIdx].capacity * 100).toFixed(0)}% cap, ${snapshot.stages[stageIdx].cycleTime}s CT</div>
        </div>
        <div class="opt-ba-arrow">→</div>
        <div class="opt-ba-box opt-after-box">
          <div class="opt-ba-label">After</div>
          <div class="opt-ba-tp">${after.toFixed(1)}</div>
          <div class="opt-ba-sub">u/min — new bottleneck: ${shadow.newBottleneckName || '—'} (${shadow.newBottleneckUtil ? shadow.newBottleneckUtil.toFixed(0) : '—'}%)</div>
        </div>
      </div>
      <div class="opt-ba-delta ${deltaClass}">
        ${sign}${delta.toFixed(1)} u/min &nbsp;|&nbsp; ${sign}${pct.toFixed(1)}% &nbsp;|&nbsp; ${stageName}: cap ${(newCap*100).toFixed(0)}%, CT ${newCT.toFixed(1)}s
      </div>`;
  }

  /** Close the scenario detail modal */
  function closeModal(e) {
    if (e && e.target) {
      const backdrop = document.getElementById('opt-modal-backdrop');
      if (e.target !== backdrop && !e.target.closest('.opt-modal-close-btn') && !e.target.closest('.opt-modal-btn-secondary')) {
        return;
      }
    }
    const backdrop = document.getElementById('opt-modal-backdrop');
    if (backdrop) backdrop.classList.remove('opt-modal-open');
    document.body.style.overflow = '';
  }

  /** Load scenario parameters directly into the Manual What-If sandbox */
  function loadScenarioIntoManual(scId) {
    closeModal();
    if (!_lastResults || _lastResults.length === 0) return;
    const sc = _lastResults.find(s => s.id === scId);
    if (!sc) return;

    let targetIdx = sc.stageIdx;
    if (targetIdx === undefined || targetIdx < 0) {
      const keys = Object.keys(sc.overrides || {});
      targetIdx = keys.length > 0 ? parseInt(keys[0], 10) : 0;
    }

    const sel   = document.getElementById('opt-manual-stage');
    const capIn = document.getElementById('opt-manual-capacity');
    const ctIn  = document.getElementById('opt-manual-ct');
    if (!sel || !capIn || !ctIn) return;

    sel.value = targetIdx;
    const ov = (sc.overrides && sc.overrides[targetIdx]) || {};
    if (ov.capacity !== undefined) {
      capIn.value = Math.round(ov.capacity * 100);
    }
    if (ov.cycleTime !== undefined) {
      ctIn.value = ov.cycleTime;
    }

    runManual();

    const manualPanel = document.getElementById('opt-manual-result');
    if (manualPanel) {
      manualPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /** Render and display the comprehensive Scenario Detail Modal */
  function showScenarioDetail(scId) {
    // If not generated yet, auto-simulate from current snapshot
    if (!_lastResults || _lastResults.length === 0 || !_lastSnapshot) {
      const snap = SimEngine.getSnapshot();
      if (!snap || !snap.stages || snap.stages.length === 0) {
        _showOptError('Simulation data not available yet. Please wait a moment.');
        return;
      }
      const scenarios = _generateScenarios(snap);
      _lastResults  = scenarios.map(s => _simulateScenario(s, snap));
      _lastSnapshot = snap;
    }

    const sc = _lastResults.find(s => s.id === scId);
    if (!sc) {
      console.warn('[WhatIfOptimizer] Scenario not found:', scId);
      return;
    }

    const snapshot = _lastSnapshot;
    const sorted = [..._lastResults].sort((a, b) => b.delta - a.delta);
    const rank = sorted.findIndex(s => s.id === sc.id);
    const isBest = (rank === 0);

    const sign = sc.pct >= 0 ? '+' : '';
    const posneg = sc.pct >= 0 ? 'opt-pos' : 'opt-neg';
    const deltaSign = sc.delta >= 0 ? '+' : '';

    const currentTP = snapshot.throughputPerMin;
    const currentBn = snapshot.bottleneckStage || (snapshot.stages[snapshot.bottleneckIdx] || snapshot.stages[0]);
    const currentBnName = currentBn ? currentBn.name : '—';
    const currentBnUtil = currentBn ? currentBn.utilization : 0;
    const currentTotalBuf = snapshot.stages.reduce((a, s) => a + s.buffer, 0);
    const currentAvgUtil = snapshot.stages.reduce((a, s) => a + s.utilization, 0) / (snapshot.stages.length || 1);

    const bufDelta = sc.totalBuffer - currentTotalBuf;
    const bufDeltaSign = bufDelta >= 0 ? '+' : '';
    const bufDeltaColor = bufDelta <= 0 ? 'color:var(--green)' : 'color:var(--red)';

    const utilDelta = sc.avgUtil - currentAvgUtil;
    const utilDeltaSign = utilDelta >= 0 ? '+' : '';

    // Badge
    const badgeHtml = isBest
      ? '<span class="opt-modal-badge opt-rank-best">🏆 Top Recommended Scenario (Rank #1)</span>'
      : (rank === 1
        ? '<span class="opt-modal-badge opt-rank-2">⚡ High-Impact Alternative (Rank #2)</span>'
        : `<span class="opt-modal-badge opt-rank-other">⚙ Scenario Option (Rank #${rank + 1})</span>`);

    // Override details
    const overrideEntries = Object.entries(sc.overrides || {}).map(([idxStr, ov]) => {
      const idx = parseInt(idxStr, 10);
      const stage = snapshot.stages[idx] || { name: 'Stage ' + (idx + 1), capacity: 1, cycleTime: 6 };
      const origCap = (stage.capacity * 100).toFixed(0);
      const newCap = ((ov.capacity !== undefined ? ov.capacity : stage.capacity) * 100).toFixed(0);
      const origCT = stage.cycleTime.toFixed(1);
      const newCT = (ov.cycleTime !== undefined ? ov.cycleTime : stage.cycleTime).toFixed(1);
      const origRate = (60 / (stage.cycleTime / (stage.capacity || 1))).toFixed(1);
      const newRate = (60 / ((ov.cycleTime || stage.cycleTime) / (ov.capacity || stage.capacity || 1))).toFixed(1);
      return {
        name: stage.name,
        origCap, newCap,
        origCT, newCT,
        origRate, newRate
      };
    });

    const paramsHtml = overrideEntries.map(e => `
      <div class="opt-modal-param-item">
        <span class="opt-modal-param-label">Target Stage</span>
        <span class="opt-modal-param-val" style="color:var(--text-primary)">${e.name}</span>
      </div>
      <div class="opt-modal-param-item">
        <span class="opt-modal-param-label">Capacity Shift</span>
        <span class="opt-modal-param-val">${e.origCap}% → ${e.newCap}%</span>
      </div>
      <div class="opt-modal-param-item">
        <span class="opt-modal-param-label">Cycle Time Shift</span>
        <span class="opt-modal-param-val">${e.origCT}s → ${e.newCT}s (${e.newRate} u/min)</span>
      </div>
    `).join('');

    // Stage-by-Stage Table
    const stagesRows = (sc.stageUtils || []).map((su, i) => {
      const orig = snapshot.stages[i] || { buffer: 0, utilization: 0 };
      const isNewBottleneck = (su.name === sc.newBottleneck);
      const isTarget = Boolean(sc.overrides && sc.overrides[i]);
      const isOldBottleneck = (orig.name === currentBnName);

      let statusBadge = '<span style="color:var(--text-muted)">Normal</span>';
      if (isNewBottleneck) {
        statusBadge = '<span style="color:var(--amber);font-weight:700">⚠️ New Bottleneck</span>';
      } else if (isTarget) {
        statusBadge = '<span style="color:var(--accent);font-weight:700">⚡ Modified</span>';
      } else if (isOldBottleneck && su.utilization < 85) {
        statusBadge = '<span style="color:var(--green);font-weight:700">✓ Relieved</span>';
      }

      const barColor = su.utilization >= 90 ? 'var(--red)' : su.utilization >= 70 ? 'var(--amber)' : 'var(--accent)';
      const bufChange = su.buffer - orig.buffer;
      const bufSign = bufChange >= 0 ? '+' : '';

      return `
        <tr>
          <td style="font-weight:600;color:var(--text-primary)">${su.name}</td>
          <td>${statusBadge}</td>
          <td>
            <div class="opt-stage-bar-wrap">
              <span style="font-family:'JetBrains Mono',monospace;font-weight:700;width:42px">${su.utilization.toFixed(1)}%</span>
              <div class="opt-stage-bar-bg">
                <div class="opt-stage-bar-fill" style="width:${Math.min(100, Math.max(0, su.utilization))}%;background:${barColor}"></div>
              </div>
            </div>
          </td>
          <td style="font-family:'JetBrains Mono',monospace">${orig.buffer} → <strong>${su.buffer}</strong> <span style="font-size:0.65rem;color:var(--text-muted)">(${bufSign}${bufChange})</span></td>
        </tr>
      `;
    }).join('');

    // Feasibility & AI assessment
    let aiFeasibility = '';
    if (sc.id === 'sc3' || sc.title.toLowerCase().includes('parallel')) {
      aiFeasibility = '<strong>Implementation Strategy:</strong> Hardware expansion — commissioning a secondary parallel station. Highest capital investment, but effectively doubles processing bandwidth and eliminates single-point equipment vulnerability.';
    } else if (sc.id === 'sc1') {
      aiFeasibility = '<strong>Implementation Strategy:</strong> Capacity expansion (+25%). Feasible through overtime staffing, dual-operator work cells, or auxiliary feeding automation. Low Capex with immediate operational throughput gains.';
    } else if (sc.id === 'sc2') {
      aiFeasibility = '<strong>Implementation Strategy:</strong> Lean / SMED cycle-time optimization (-25%). Achieved through jig re-engineering, robotic rapid-clamping, or feed-rate calibration. Zero hardware acquisition required.';
    } else if (sc.id === 'sc4') {
      aiFeasibility = '<strong>Implementation Strategy:</strong> Proactive downstream re-balancing. Optimizes the secondary constraint so relieving the primary bottleneck does not immediately stall downstream stages.';
    } else {
      aiFeasibility = '<strong>Implementation Strategy:</strong> Synchronized line balancing. Adjusts multiple work centers to align with takt time, smoothing material flow and reducing overall factory queue accumulation.';
    }

    const warningHtml = (sc.newBottleneckUtil >= 85)
      ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(245,158,11,0.1);border-left:3px solid var(--amber);border-radius:4px;color:var(--amber);font-size:0.72rem">
          <strong>⚠️ Constraint Migration Warning:</strong> Shadow simulation indicates <strong>${sc.newBottleneck}</strong> will become the successor bottleneck at <strong>${sc.newBottleneckUtil.toFixed(1)}% utilization</strong>. Prioritize buffer sizing and feed rates at this stage.
         </div>`
      : '';

    const dialog = document.getElementById('opt-modal-dialog');
    const backdrop = document.getElementById('opt-modal-backdrop');
    if (!dialog || !backdrop) return;

    dialog.innerHTML = `
      <div class="opt-modal-header">
        <div class="opt-modal-header-info">
          ${badgeHtml}
          <div class="opt-modal-title">${sc.title}</div>
          <div class="opt-modal-desc">${sc.desc}</div>
        </div>
        <button class="opt-modal-close-btn" onclick="WhatIfOptimizer.closeModal()" title="Close">&times;</button>
      </div>

      <div class="opt-modal-body">
        <!-- Key KPIs -->
        <div class="opt-modal-kpi-grid">
          <div class="opt-modal-kpi-card">
            <div class="opt-modal-kpi-label">Projected Throughput</div>
            <div class="opt-modal-kpi-val ${posneg}">${sc.throughput.toFixed(1)} <span style="font-size:0.7rem;font-weight:500;color:var(--text-muted)">u/min</span></div>
            <div class="opt-modal-kpi-sub ${posneg}">
              <span>${deltaSign}${sc.delta.toFixed(1)} u/min</span>
              <span>(${sign}${sc.pct.toFixed(1)}%)</span>
            </div>
          </div>

          <div class="opt-modal-kpi-card">
            <div class="opt-modal-kpi-label">Bottleneck Migration</div>
            <div class="opt-modal-kpi-val" style="font-size:0.95rem;color:var(--amber)">${sc.newBottleneck}</div>
            <div class="opt-modal-kpi-sub" style="color:var(--text-muted)">
              <span>Prev: ${currentBnName} (${currentBnUtil.toFixed(0)}%)</span>
            </div>
          </div>

          <div class="opt-modal-kpi-card">
            <div class="opt-modal-kpi-label">Total Line Buffer WIP</div>
            <div class="opt-modal-kpi-val">${sc.totalBuffer} <span style="font-size:0.7rem;font-weight:500;color:var(--text-muted)">units</span></div>
            <div class="opt-modal-kpi-sub" style="${bufDeltaColor}">
              <span>${bufDeltaSign}${bufDelta} vs current (${currentTotalBuf})</span>
            </div>
          </div>

          <div class="opt-modal-kpi-card">
            <div class="opt-modal-kpi-label">Average Utilization</div>
            <div class="opt-modal-kpi-val">${sc.avgUtil.toFixed(1)}%</div>
            <div class="opt-modal-kpi-sub" style="color:var(--accent)">
              <span>${utilDeltaSign}${utilDelta.toFixed(1)}% vs current (${currentAvgUtil.toFixed(1)}%)</span>
            </div>
          </div>
        </div>

        <!-- Parameters Changed -->
        <div>
          <div class="opt-modal-section-title">🔧 Applied Interventions & Parameters</div>
          <div class="opt-modal-params-box">
            ${paramsHtml}
          </div>
        </div>

        <!-- Stage Impact Table -->
        <div>
          <div class="opt-modal-section-title">📊 Simulated Line-Wide Stage Performance</div>
          <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden">
            <table class="opt-modal-stage-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Simulation Role</th>
                  <th>Projected Utilization</th>
                  <th>WIP Buffer</th>
                </tr>
              </thead>
              <tbody>
                ${stagesRows}
              </tbody>
            </table>
          </div>
        </div>

        <!-- AI Insight & Guidance -->
        <div>
          <div class="opt-modal-section-title">🤖 AI Feasibility & Risk Assessment</div>
          <div class="opt-modal-ai-box">
            <p>${aiFeasibility}</p>
            ${warningHtml}
          </div>
        </div>
      </div>

      <div class="opt-modal-footer">
        <button class="opt-modal-btn opt-modal-btn-secondary" onclick="WhatIfOptimizer.closeModal()">Close</button>
        <button class="opt-modal-btn opt-modal-btn-primary" onclick="WhatIfOptimizer.loadScenarioIntoManual('${sc.id}')">⚙ Test in Manual Simulator</button>
      </div>
    `;

    backdrop.classList.add('opt-modal-open');
    document.body.style.overflow = 'hidden';
  }

  function _showOptError(msg) {
    const ai = document.getElementById('opt-ai-block');
    if (ai) ai.innerHTML = `<div style="color:var(--red);font-size:0.78rem;padding:10px">⚠ ${msg}</div>`;
  }

  return { init, runOptimize, runManual, showScenarioDetail, closeModal, loadScenarioIntoManual };

})();

// Boot: initialise after the existing App.init has run
window.addEventListener('DOMContentLoaded', function() {
  // Slight delay so SimEngine is guaranteed to have started
  setTimeout(WhatIfOptimizer.init, 200);
});
