# 🏭 FactoryTwin AI — Production Line Digital Twin & Bottleneck Intelligence

> **Smart Industry Hackathon Project**  
> Real-time production line digital twin with bottleneck detection, what-if shadow simulation, rule-based AI optimization, and mathematical root-cause intelligence.

🌐 **Live Demo:** [https://giri-0518.github.io/Factory-Twin/](https://giri-0518.github.io/Factory-Twin/)  
📦 **Repository:** [https://github.com/GIRI-0518/Factory-Twin](https://github.com/GIRI-0518/Factory-Twin)

---

## 🚀 Key Features

### 1. 📊 Real-Time Digital Twin Dashboard
- Deterministic multi-stage state machine (`SimEngine`) running at 200ms tick intervals.
- Live rolling throughput tracker (units/minute) powered by Chart.js.
- Active stage monitoring (Raw Input → Cutting → Welding → Assembly → Quality Control → Packaging).
- Buffer queue lengths, machine status (Running, Idle, Starved, Blocked, Breakdown), and utilization metrics.

### 2. 🎛️ Interactive Line Controls
- Dynamic capacity multipliers ($0\% - 200\%$) and cycle time adjustment sliders ($1\text{s} - 60\text{s}$).
- Simulation speed modulation ($0.5\times$ to $5\times$).
- Simulated equipment breakdown inject button to evaluate line downtime propagation and starvation recovery.

### 3. 🤖 AI What-If Optimizer
- Multi-scenario shadow simulator evaluating 5 automated interventions without interrupting live factory operations:
  - Bottleneck capacity boost ($+25\%$)
  - SMED cycle time reduction ($-25\%$)
  - Parallel machine deployment ($2\times$ capacity)
  - Downstream pre-emption
  - Synchronized line balancing
- Detailed scenario comparison matrix and interactive Scenario Detail Modal with stage-by-stage shadow simulation metrics.
- Manual What-If sandbox for custom parameter experimentation.

### 4. 🔴 Bottleneck Root-Cause Engine
- Live constraint spotlight identifying the active bottleneck machine.
- Structured causal breakdown:
  - **Primary Root Cause**: Arrival rate vs processing capacity rate deficit ($\Delta$).
  - **Secondary Factor**: Sustained utilization and lack of idle headroom.
  - **Contributing Influence**: Cycle time disparity vs line takt average.
- **Rule-Based Root-Cause Contribution Scores**: Mathematical contribution percentages for Capacity Constraint, High Utilization, Queue Growth / WIP Pressure, Processing Time Disparity, and Downtime.
- **Causal Propagation Chain**: Visual 6-node flow tracing from upstream feed to capacity gap to WIP backlog to downstream starvation to overall line output cap.
- **Interactive "WHY IS THIS A BOTTLENECK?" Dialog**: Generates dynamic plain-English explanations and step-by-step mathematical proofs derived from live machine data.
- **Factory-Wide Machine Constraint Matrix**: Full comparative table ranking all stations by constraint severity.

---

## 🛠️ Technology Stack

- **Frontend**: Vanilla HTML5, CSS3, JavaScript (ES6+).
- **Visualization**: Chart.js (CDN).
- **Architecture**: Decoupled, modular event-driven pattern (`SimEngine`, `Renderer`, `RecommendationEngine`, `WhatIfOptimizer`, `RootCauseEngine`).
- **Deployment**: Zero-dependency static web application hosted on GitHub Pages.

---

## 💻 Local Setup

Simply clone the repository and open `index.html` in any modern web browser:

```bash
git clone https://github.com/GIRI-0518/Factory-Twin.git
cd Factory-Twin
# Open index.html directly or with live-server
```
