# OS Dashboard Backend Integration Guide

This frontend provides a beautiful, visually engaging interface for real-time monitoring of your custom operating system project. It utilizes a `MockOSService` to simulate live data. 

To bridge this frontend with your actual operating system project (typically written in C, C++, or Rust), you should implement a simple WebSocket server or HTTP API on your OS backend that broadcasts real metrics, and replace the `MockOSService` on the frontend.

## 1. Setting up the Connector (Frontend)
Right now, all data flows through `src/services/mockOSService.js`.
To connect this to your backend, change this file to use native `WebSocket`.

```javascript
// src/services/osService.js
class RealOSService {
  constructor() {
    this.listeners = [];
    this.ws = new WebSocket('ws://localhost:8080/metrics'); // Your OS Backend Port
    this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.notifyListeners(data);
    };
  }
  
  subscribe(callback) {
    this.listeners.push(callback);
    return () => this.listeners = this.listeners.filter(cb => cb !== callback);
  }

  notifyListeners(data) {
    this.listeners.forEach(cb => cb(data));
  }

  // OS Management Actions
  killProcess(pid) {
    this.ws.send(JSON.stringify({ action: 'kill', pid }));
  }
  suspendProcess(pid) {
    this.ws.send(JSON.stringify({ action: 'suspend', pid }));
  }
  resumeProcess(pid) {
    this.ws.send(JSON.stringify({ action: 'resume', pid }));
  }
}

export const osService = new RealOSService();
```

## 2. Setting up the Backend (Your OS)
Your operating system background service should accept the WebSocket connection.
Every ~1 second, your OS should send a JSON payload matching the expected state schema:

```json
{
  "cpu": {
    "usage": 45.2,
    "cores": 8,
    "freq": "2.9 GHz",
    "loadAvg": [1.15, 1.45, 1.05],
    "history": []
  },
  "memory": {
    "total": 16.0,
    "used": 8.4,
    "free": 7.6,
    "swap": 0.5,
    "history": []
  },
  "disk": {
    "total": 512,
    "used": 240,
    "free": 272,
    "usagePercent": 46.8
  },
  "system": {
    "os": "MyCustom OS v0.1",
    "uptime": "1d 2h",
    "hostname": "test-vm"
  },
  "processes": {
    "total": 50,
    "running": 2,
    "sleeping": 48,
    "zombie": 0,
    "list": [
      { "pid": 1, "name": "init", "cpu": 0.1, "mem": 0.2, "status": "Running", "threads": 1 }
    ]
  },
  "network": {
    "upload": 1.2,
    "download": 5.4,
    "connections": 34
  }
}
```

By conforming to this payload, the entire UI and its stunning visual charts will render your actual OS system data in real-time, instantly elevating your project's presentation!
