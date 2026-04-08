# Smart Factory Safety Monitoring & Control System

A professional industrial automation dashboard and simulation platform built for monitoring factory telemetry and managing environmental safety thresholds in real-time.

## 🏭 Project Overview

The **Smart Factory Safety System** is a professional-grade full-stack application designed to visualize and manage industrial environments. It features a futuristic, premium industrial control room aesthetic (glassmorphism/dark mode) and provides a robust engine for both real-world sensor integration and synthetic simulation.

### Key Capabilities
- **Real-time Telemetry**: Monitoring of Gas levels, Fire status, Proximity, Machine temperature, and Current draw.
- **Dynamic Thresholding**: Fine-tune safety limits per machine; the system automatically triggers alerts and fail-safes.
- **Actuator Control**: Automated control of cooling fans (thermal management) and emergency broadcasts.
- **Relational DBMS**: Built on a professional MySQL foundation with explicit data integrity and foreign keys.

---

## 🏗️ Architecture & Tech Stack

### Backend
- **Node.js & Express**: High-performance API layer.
- **MySQL**: Relational database for persistent storage (users, logs, configurations).
- **Simulation Service**: A background logic engine managing ticking telemetry and automated triggers.

### Frontend
- **Vanilla HTML5 & CSS3**: Custom premium UI with glass effects and industrial typography.
- **Vanilla JavaScript**: Lightweight, low-latency polling system for real-time updates.

---

## 📂 Project Structure

```text
├── public/                 # Frontend assets (Static HTML/CSS/JS)
│   ├── index.html          # Authentication gate (Login/Register/Sim)
│   ├── dashboard.html      # Primary monitoring HUD (Numerical-First)
│   ├── machines.html       # Module deployment & threshold configuration
│   ├── control.html        # Manual actuator overrides & logs
│   ├── graphs.html         # Real-time and historical analytics
│   ├── alerts.html         # Incident log & reporting
│   └── forge.css           # Premium Industrial UI Design System
├── routes/
│   └── api.js              # RESTful API endpoints for all factory operations
├── services/
│   ├── factory_ingest.js   # Hardware data ingestion logic
│   └── simulation.js       # Synthetic data generation & automation
├── db.js                   # MySQL Connection Pool
├── server.js               # Express application and WebSocket entry point
├── .env                    # System environment configuration
└── package.json            # Deployment dependencies
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js** (v14+)
- **MySQL Server**

### 2. Environment Configuration
Create a `.env` file in the root directory:
```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=smart_factory
PORT=3001
```

### 3. Installation & Launch
```bash
npm install
npm start
```
Access the dashboard at `http://localhost:3001`.

---

## ⚖️ License
Distributed under the ISC License.
