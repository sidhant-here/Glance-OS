# SysVision OS Dashboard

A high-performance, real-time graphical dashboard for monitoring system processes, CPU, memory, network, and disk usage.

## Features
- **Real-Time Telemetry:** Streams live CPU, memory, and disk stats from native Windows performance counters (`telemetry.ps1`) via WebSocket every 500ms.
- **Process Management:** View live processes, including their states, CPU, and memory footprint.
- **Process Actions:** You can now **Pause**, **Resume**, and **Kill** real system processes directly from the dashboard UI.
- **60fps Interpolation Engine:** Smooth frontend rendering using `requestAnimationFrame` for gauges and charts.
- **Alerting System:** Automatic notifications when CPU exceeds 90% or Memory exceeds 85%.
- **Beautiful UI:** Custom styling with light, dark, and arctic themes, complete with interactive components and real-time canvas charting.

## Getting Started

### Prerequisites
- Node.js installed
- Windows OS (for full telemetry features)

### Running Locally
```bash
npm install
npm run dev
```

The frontend will be available at `http://localhost:5173`, and the WebSocket server handles real-time data at `ws://localhost:8765`.

## Architecture
- **Frontend:** Pure HTML/CSS/JS (served by Vite) in `index.html`. 
- **Backend:** Node.js Vite Plugin in `vite.config.js`. Serves REST endpoints (`/api/pause`, `/api/resume`, `/api/kill`) and broadcasts WebSocket data.
- **Native Bridges:**
  - `telemetry.ps1`: Harvests exact Windows counter metrics every 500ms.
  - `suspend.ps1`: Utility script that uses `ntdll.dll` to safely pause/resume running Windows processes.
