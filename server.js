const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const apiRoutes = require('./routes/api');
const pool = require('./db');
const simulationService = require('./services/simulation'); 
const factoryIngest = require('./services/factory_ingest');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001; // Migrated to 3001 to resolve EADDRINUSE conflict

console.log("Simulation Engine Loaded. State: " + (simulationService.isRunning ? "Running" : "Stopped"));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api', apiRoutes);

// Database initialization check
pool.getConnection()
    .then(conn => {
        console.log("Successfully connected to MySQL Database.");
        conn.release();
    })
    .catch(err => {
        console.error("Failed to connect to MySQL database.");
    });


// ==========================================
// WebSocket Server — Unified inside server.js
// ==========================================
const wss = new WebSocketServer({ server });

let espClient = null;           // The connected ESP32
const browserClients = new Set(); // All connected website browsers

wss.on('connection', (socket, request) => {
  const path = request.url;

  // ── ESP32 connection ──────────────────────────────────────
  if (path === '/esp') {
    // 1. Session Handover: Gracefully close old ghost session
    if (espClient) {
      console.log('[SERVER] Handover: Closing old ESP32 session.');
      espClient.terminate();
    }

    espClient = socket;
    socket.is_alive = true; // Essential for the pruning loop
    console.log('[SERVER] ESP32 connected.');

    socket.on('message', async (data) => {
      socket.is_alive = true; // Pulse detected
      const msg = data.toString();
      try {
        const parsed = JSON.parse(msg);

        // Hardware Data Ingestion (Unified via Smart Factory Ingest)
        // Check if it's a raw sensor object (Dumb Node v2) or traditional format
        const isSensorData = parsed.type === 'sensor_data' || (parsed.temp !== undefined || parsed.gas !== undefined);

        if (isSensorData) {
            // Ensure we treat it as sensor_data for the rest of path
          if (!parsed.type) parsed.type = 'sensor_data';

          // 1. BROADCAST IMMEDIATELY to all browser clients (Remove Latency)
          const broadcastMsg = JSON.stringify(parsed);
          browserClients.forEach(client => {
            if (client.readyState === 1) client.send(broadcastMsg);
          });

          // 2. LOG TO DATABASE (Background task - don't await ingestion for UI update)
          let targetUserId = 1; 
          for (let client of browserClients) {
            if (client.userId) { targetUserId = client.userId; break; }
          }
          
          factoryIngest.process(targetUserId, parsed, false).catch(e => {
            console.error('[Smart Factory] DB Logging Error:', e);
          });
          
          console.log('[Smart Factory] Telemetry broadcasted instantly and logged to DB.');
          return; // Already broadcasted
        }

        // Forward other messages (e.g., status updates)
        const forwardMsg = msg;
        browserClients.forEach(client => {
          if (client.readyState === 1) client.send(forwardMsg);
        });
      } catch (e) {
        console.error('[SERVER] ESP32 Message processing error:', e);
      }
    });

    socket.on('close', () => {
      espClient = null;
      console.log('[SERVER] ESP32 disconnected.');
      const offlineMsg = JSON.stringify({ type: 'esp_offline' });
      browserClients.forEach(c => { if (c.readyState === 1) c.send(offlineMsg); });
    });
  }

  // ── Browser / Website connection ──────────────────────────
  else if (path === '/client') {
    browserClients.add(socket);
    console.log(`[SERVER] Browser connected. Total: ${browserClients.size}`);
    
    socket.is_alive = true;
    socket.on('pong', () => { socket.is_alive = true; });

    socket.on('message', async (data) => {
      try {
        const msg = data.toString();
        const parsed = JSON.parse(msg);

        if (parsed.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', ts: parsed.ts || Date.now() }));
          return;
        }

        if (parsed.type === 'auth_handshake') {
          socket.userId = parsed.userId;
          console.log(`[SERVER] Browser ID linked to User: ${parsed.userId}`);
          // Ensure we have a system config entry
          await pool.query('INSERT INTO system_config (user_id, auto_pilot) VALUES (?, 1) ON DUPLICATE KEY UPDATE user_id=user_id', [parsed.userId]);
          return;
        }

        console.log('[SERVER] Command from website:', msg);
        // Forward command to ESP32
        if (espClient && espClient.readyState === 1) {
          espClient.send(msg);
        } else {
          socket.send(JSON.stringify({ type: 'error', msg: 'ESP32 offline' }));
        }
      } catch(e) { console.error('[SERVER] Browser message error:', e); }
    });

    socket.on('close', () => {
      browserClients.delete(socket);
      console.log(`[SERVER] Browser disconnected. Total: ${browserClients.size}`);
    });
  }

  else {
    socket.close();
  }
});

// Periodic Pruning (Every 30 seconds)
setInterval(() => {
  wss.clients.forEach(client => {
    if (client.is_alive === false) {
      console.log('[SERVER] Pruning zombie connection...');
      return client.terminate();
    }
    client.is_alive = false;
    client.ping();
  });
}, 30000);

// Start Unified Factory Node
server.listen(PORT, () => {
    console.log(`\x1b[36m[SMART FACTORY SERVER] Running on  → http://localhost:${PORT}\x1b[0m`);
    console.log(`\x1b[32m[SMART FACTORY SERVER] HW Link      → ws://localhost:${PORT}/esp\x1b[0m`);
    console.log(`\x1b[35m[SMART FACTORY SERVER] Client Link  → ws://localhost:${PORT}/client\x1b[0m`);
});
