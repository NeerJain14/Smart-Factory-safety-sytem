/* ══════════════════════════════════════════════════════════════
   Smart Factory Safety System — Global JavaScript Engine
   ══════════════════════════════════════════════════════════════ */

/* ── Dot-Grid Canvas ──────────────────────── */
function initDotGrid() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const SPACING = 44;
  let t = 0;
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cols = Math.ceil(canvas.width / SPACING) + 1;
    const rows = Math.ceil(canvas.height / SPACING) + 1;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const phase = (i * 0.28 + j * 0.52 + t) * 0.9;
        const alpha = 0.07 + ((Math.sin(phase) + 1) / 2) * 0.2;
        ctx.beginPath();
        ctx.arc(i * SPACING, j * SPACING, 1.3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,240,255,${alpha})`;
        ctx.fill();
      }
    }
    t += 0.011;
    requestAnimationFrame(draw);
  }
  draw();
}

/* ── SimEngine — Client-Side Live Data ────── */
const SimEngine = {
  isRunning: false,
  sensors: {
    ambTemp:   { value: 27.4, min: 10, max: 95, warnAt: 60, dangerAt: 80 },
    gasLevel:  { value: 21.8, min: 0,  max: 100, warnAt: 40, dangerAt: 65 },
    fireDet:   { value: 0,    min: 0,  max: 1,   warnAt: 0.5, dangerAt: 1 },
    proximity: { value: 0.28, min: 0,  max: 1,   warnAt: 0.6, dangerAt: 0.9 }
  },
  machines: [],
  alertLog: [],
  actuatorLog: [],
  drift(s) {
    const d = (Math.random() - 0.5) * 0.4;
    const lo = s.min !== undefined ? s.min : 0;
    const hi = s.max !== undefined ? s.max : 100;
    s.value = Math.max(lo, Math.min(hi, s.value + d));
  },
  spike(s, isBinary) {
    if (isBinary) {
      // Binary sensors: randomly toggle between 0 and 1
      if (Math.random() < 0.03) s.value = s.value >= 1 ? 0 : 1;
      return;
    }
    if (Math.random() < 0.04) {
      const peak = (s.dangerAt || s.max || 100) * 0.15;
      const hi = s.max !== undefined ? s.max : 100;
      s.value = Math.min(hi, s.value + peak);
    }
  },
  getStatus(s) {
    if (s.value === null || s.value === undefined) return 'OFFLINE';
    if (s.dangerAt !== undefined && s.value >= s.dangerAt) return 'DANGER';
    if (s.warnAt  !== undefined && s.value >= s.warnAt)  return 'WARNING';
    return 'SAFE';
  },
  pushAlert(type, severity, message, source) {
    const entry = { id: Date.now(), timestamp: new Date().toLocaleString(), type, severity, message, source };
    this.alertLog.unshift(entry);
    if (this.alertLog.length > 200) this.alertLog.pop();
    document.dispatchEvent(new CustomEvent('newAlert', { detail: entry }));
  },
  tick() {
    Object.entries(this.sensors).forEach(([key, s]) => {
      const prevStatus = this.getStatus(s);
      const isBinary = (key === 'fireDet' || key === 'proximity');
      this.spike(s, isBinary);
      if (!isBinary) this.drift(s);
      const nowStatus = this.getStatus(s);
      if (nowStatus !== prevStatus && (nowStatus === 'WARNING' || nowStatus === 'DANGER')) {
        this.pushAlert(
          `${key.toUpperCase()}_${nowStatus}`, nowStatus,
          `${nowStatus === 'DANGER' ? 'Critical' : 'Elevated'} ${key} reading: ${s.value.toFixed(1)}`,
          'GLOBAL ENV'
        );
      }
    });
    this.machines.forEach(m => {
      [m.temp, m.current].forEach(s => { this.spike(s, false); this.drift(s); });
    });
    document.dispatchEvent(new CustomEvent('sensorUpdate', { detail: { sensors: this.sensors, machines: this.machines } }));
  },
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const auth = getAuthInfo();
    const isSim = auth ? auth.isSim : false;

    if (!isSim) {
      Object.values(this.sensors).forEach(s => s.value = null);
    }

    // Dynamically load real deployed machines from DB
    if (auth) {
        try {
            const res = await fetch(`/api/machines?user_id=${auth.userId}${auth.simParam}`);
            const data = await res.json();
            if (data.success) {
                this.machines = data.data.map(m => ({
                    id: m.machine_id, 
                    name: m.machine_name, 
                    location: m.location,
                    temp: { value: isSim ? 40 : null, min: 20, max: 100, warnAt: (m.temp_limit || 50) * 0.8, dangerAt: m.temp_limit || 50 },
                    current: { value: isSim ? 7 : null, min: 0, max: 25, warnAt: (m.current_limit || 30) * 0.8, dangerAt: m.current_limit || 30 }
                }));
            }
        } catch(e) { console.error('SimEngine failed to load machines'); }
    }

    document.dispatchEvent(new CustomEvent('machinesLoaded'));
    if (isSim) {
        setInterval(() => this.tick(), 2000);
    } else {
        document.dispatchEvent(new CustomEvent('sensorUpdate', { detail: { sensors: this.sensors, machines: this.machines } }));
        
        // Poll for machine threshold changes live
        setInterval(async () => {
             if (!auth) return;
             try {
                 const res = await fetch(`/api/machines?user_id=${auth.userId}${auth.simParam}`);
                 const data = await res.json();
                 if (data.success) {
                     data.data.forEach(m => {
                         const ext = this.machines.find(x => x.id === m.machine_id);
                         if(ext) {
                             ext.temp.dangerAt = m.temp_limit || 50;
                             ext.temp.warnAt = (m.temp_limit || 50) * 0.8;
                             ext.current.dangerAt = m.current_limit || 30;
                             ext.current.warnAt = (m.current_limit || 30) * 0.8;
                         }
                     });
                 }
                 
                 // Also poll environment thresholds
                 const eRes = await fetch(`/api/environments?user_id=${auth.userId}${auth.simParam}`);
                 const eData = await eRes.json();
                 if (eData.success && eData.data.length > 0) {
                     const env = eData.data[0];
                     if(this.sensors.ambTemp) {
                        this.sensors.ambTemp.dangerAt = env.temperature_limit || 60;
                        this.sensors.ambTemp.warnAt = (env.temperature_limit || 60) * 0.8;
                     }
                     if(this.sensors.gasLevel) {
                        this.sensors.gasLevel.dangerAt = env.gas_limit || 40;
                        this.sensors.gasLevel.warnAt = (env.gas_limit || 40) * 0.8;
                     }
                     if(this.sensors.fireDet) {
                        this.sensors.fireDet.dangerAt = 1; // Always binary danger
                        this.sensors.fireDet.warnAt = 0.5;
                     }
                 }
             } catch(e) {}
        }, 5000);
    }
  }
};

/* ── Scroll Reveal ────────────────────────── */
function initScrollReveal() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
}

/* ── Animate Counter ──────────────────────── */
function animateCounter(el, from, to, duration) {
  duration = duration || 400;
  const start = performance.now();
  function frame(now) {
    const p = Math.min((now - start) / duration, 1);
    const ease = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
    el.textContent = (from + (to - from) * ease).toFixed(to % 1 !== 0 ? 1 : 0);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ── Live Clock ───────────────────────────── */
function initLiveClock() {
  const clocks = document.querySelectorAll('.live-clock');
  const tick = () => clocks.forEach(c => c.textContent = new Date().toLocaleTimeString('en-GB'));
  tick();
  setInterval(tick, 1000);
}

/* ── Auth Helpers ─────────────────────────── */
function logout() {
  const isSim = sessionStorage.getItem('mode') === 'simulation';
  if (isSim) { fetch('/api/simulation/stop', { method: 'POST' }).catch(() => {}); }
  sessionStorage.clear();
  window.location.href = 'index.html';
}

function initUserAvatar() {
  const user = JSON.parse(sessionStorage.getItem('user'));
  const el = document.getElementById('user-avatar');
  if (el && user) {
    const initials = (user.name || user.email || '??').split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
    el.textContent = initials;
  }
}

function getAuthInfo() {
  const user = JSON.parse(sessionStorage.getItem('user'));
  if (!user) {
    const page = window.location.pathname.split('/').pop();
    if (page !== 'index.html' && page !== '') {
        window.location.href = 'index.html';
    }
    return null;
  }
  const isSim = sessionStorage.getItem('mode') === 'simulation' || (user && user.role === 'simulation');
  const userId = user.user_id;
  const simParam = isSim ? '&is_sim=true' : '';
  return { user, isSim, userId, simParam };
}

/* ── Active Rail Highlight ────────────────── */
function initActiveRail() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.rail-btn').forEach(btn => {
    if (btn.getAttribute('href') === page) btn.classList.add('active');
  });
}

/* ── Hardware Connection (WebSockets with Heartbeat) ─ */
let lastUpdateTs = 0;
let activeWS = null; 
let reconnectDelay = 1000; // Exponential backoff starts at 1s
const MAX_RECONNECT_DELAY = 10000;

function initHardwareLink() {
  // 1. Singleton Protection Enhancement
  if (activeWS && (activeWS.readyState === WebSocket.OPEN || activeWS.readyState === WebSocket.CONNECTING)) {
    return;
  }
  
  const wsUrl = `ws://${window.location.hostname}:${window.location.port || 3000}/client`;
  console.log(`[HardwareLink] Attempting connection to ${wsUrl}...`);
  
  const ws = new WebSocket(wsUrl);
  activeWS = ws;

  const orb = document.querySelector('.hud-stats .stat-orb:first-child');
  let heartbeatInterval;

  ws.onopen = () => {
    reconnectDelay = 1000; // Reset backoff on successful connection
    if (orb) {
      orb.querySelector('.orb-count').textContent = '● HARDWARE LINKED';
      orb.querySelector('.orb-count').style.color = 'var(--cyan)';
      orb.classList.add('online');
    }
    
    // Auth Handshake
    const auth = getAuthInfo();
    if (auth) ws.send(JSON.stringify({ type: 'auth_handshake', userId: auth.userId }));

    // Init Heartbeat (keep mobile hotspot alive - 5s cycle)
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    }, 5000);
  };

  // Smart Factory Brain State
  let controlRules = [];
  let systemConfig = { auto_pilot: true };
  const hwState = { cooling_fan: null, power_cutoff: null };

  const refreshSafetyEngine = async () => {
    const auth = getAuthInfo();
    if (!auth) return;
    try {
      const [rRes, cRes] = await Promise.all([
        fetch(`/api/control/rules?user_id=${auth.userId}`),
        fetch(`/api/control/config?user_id=${auth.userId}`)
      ]);
      const [rData, cData] = await Promise.all([rRes.json(), cRes.json()]);
      if (rData.success) {
          controlRules = rData.data;
          // Sync UI Gauges with DB Rules
          controlRules.forEach(rule => {
             let sensor = null;
             if (rule.sensor_type === 'temperature') sensor = SimEngine.sensors.ambTemp;
             if (rule.sensor_type === 'gas') sensor = SimEngine.sensors.gasLevel;
             if (rule.sensor_type === 'fire') sensor = SimEngine.sensors.fireDet;
             
             if (sensor) {
                if (rule.action === 'on' && rule.actuator_type === 'cooling_fan') sensor.warnAt = rule.threshold_val;
                if (rule.action === 'on' && rule.actuator_type === 'power_cutoff') sensor.dangerAt = rule.threshold_val;
             }
          });
      }
      if (cData.success) systemConfig = cData.data;
    } catch(e) { console.error('[SafetyEngine] Failed to sync rules'); }
  };

  // Sync brain every 3 seconds to catch UI updates and threshold changes
  refreshSafetyEngine();
  setInterval(refreshSafetyEngine, 3000);

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'sensor_data') {
        const src = payload.data || payload;
        const config = getAuthInfo();

        // 1. Sync values to UI Engine (Normalize keys for Dumb Node v2)
        const curTemp  = src.temp  !== undefined ? +src.temp  : (src.machine_temp_c !== undefined ? +src.machine_temp_c : 0);
        const curGas   = src.gas   !== undefined ? +src.gas   : (src.gas_adc !== undefined ? +src.gas_adc : 0);
        const hasFlame = src.flame !== undefined ? !!src.flame : (src.flame_detected !== undefined ? !!src.flame_detected : false);

        // Env Temp is hidden for now as per user request (waiting for secondary sensor)
        SimEngine.sensors.ambTemp.value = null; 
        
        SimEngine.sensors.gasLevel.value = curGas;
        SimEngine.sensors.fireDet.value = hasFlame ? 1 : 0;
        
        const m0 = SimEngine.machines[0];
        if (m0) m0.temp.value = curTemp;

        // ── 2. THROTTLED UI UPDATE ─────────────────────
        // Fix: Don't overload the browser with too many re-renders per second
        const now = Date.now();
        if (now - lastUpdateTs > 120) { // Max ~8Hz updates for UI stability
            lastUpdateTs = now;
            document.dispatchEvent(new CustomEvent('sensorUpdate', { detail: { sensors: SimEngine.sensors, machines: SimEngine.machines } }));
        }

        // ── 3. CENTRALIZED DECISION ENGINE (Safety Engine) ──
        const activeActions = { cooling_fan: false, power_cutoff: false };

        // Logic Rule A: Flame Detection -> INTERLOCK FAN
        if (hasFlame) activeActions.cooling_fan = true;

        // Logic Rule B: Thermal Overload -> Shutdown System
        if (m0 && curTemp >= m0.temp.dangerAt) activeActions.power_cutoff = true;

        // Dispatch Actuator Commands
        Object.keys(activeActions).forEach(act => {
          const target = activeActions[act];
          if (target !== hwState[act]) {
            hwState[act] = target;
            const cmd = (act === 'cooling_fan') ? (target ? 'fan_on' : 'fan_off') : (target ? 'buzz_on' : 'buzz_off');
            window.HardwareLink.sendCommand(cmd);
            
            // Log to Database
            if (config) {
               fetch('/api/actuators/control', { 
                   method:'POST', headers:{'Content-Type':'application/json'}, 
                   body: JSON.stringify({ 
                       user_id: config.userId, 
                       actuator_id: act === 'cooling_fan' ? 1 : 2, 
                       action: target ? 'ACTIVATE' : 'DEACTIVATE', 
                       trigger_type: 'Safety Engine' 
                   }) 
               }).catch(e=>{});
            }
          }
        });

        // 3. LCD SCREEN STATE MANAGEMENT
        const gasLimit = SimEngine.sensors.gasLevel.dangerAt || 400;
        if (curGas >= gasLimit) {
           if (hwState.currentScreen !== 'GAS') {
               hwState.currentScreen = 'GAS';
               window.HardwareLink.sendCommand('screen_gas');
           }
        } else if (hwState.currentScreen !== 'MAIN') {
           hwState.currentScreen = 'MAIN';
           window.HardwareLink.sendCommand('screen_main');
        }

        document.dispatchEvent(new CustomEvent('sensorUpdate', { detail: { sensors: SimEngine.sensors, machines: SimEngine.machines } }));
      }
      else if (payload.type === 'pong') {
        const latency = Date.now() - (payload.ts || 0);
        if (orb) {
            orb.querySelector('.orb-label').textContent = `LATENCY: ${latency}ms`;
        }
      }
      else if (payload.type === 'esp_offline') {
        if (orb) {
          orb.querySelector('.orb-count').textContent = '○ HARDWARE DOWN';
          orb.querySelector('.orb-count').style.color = 'var(--t3)';
          orb.classList.remove('online');
          orb.querySelector('.orb-label').textContent = 'SYSTEM';
        }
      }
    } catch(e) { console.error('[SafetyEngine] Processor Error:', e); }
  };

  ws.onclose = (event) => {
    console.warn(`[HardwareLink] Socket closed (Code: ${event.code}). Reconnecting in ${reconnectDelay}ms...`);
    clearInterval(heartbeatInterval);
    activeWS = null;

    if (orb) {
      orb.querySelector('.orb-count').textContent = '◌ RECONNECTING...';
      orb.querySelector('.orb-count').style.color = 'var(--warn)';
      orb.classList.remove('online');
    }

    // Exponential Backoff
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      initHardwareLink();
    }, reconnectDelay);
  };

  ws.onerror = (err) => {
    console.error('[HardwareLink] WebSocket Error:', err);
    ws.close(); // Force a clean close for the onclose handler to fire
  };

  window.HardwareLink = { 
    sendCommand: (cmd, extra={}) => { 
        if (ws.readyState === WebSocket.OPEN) {
            if (cmd === 'lcd_msg') {
                const isBroadcast = extra.isBroadcast || false;
                if (isBroadcast) {
                    window.lcdInterruptActive = true;
                    // Firmware v9 handles the "FROM WEBSITE" header locally
                    ws.send(JSON.stringify({cmd: 'lcd_msg', msg: extra.msg || extra.text}));
                    setTimeout(() => { window.lcdInterruptActive = false; }, 8000);
                } else {
                    ws.send(JSON.stringify({cmd: 'lcd_msg', msg: extra.msg || extra.text}));
                }
            } else {
                ws.send(JSON.stringify({cmd, ...extra})); 
            }
        } 
    } 
  };
}

/* ── Global Init ──────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initDotGrid();
  initScrollReveal();
  SimEngine.start();
  initLiveClock();
  initUserAvatar();
  initActiveRail();
  
  
  if (sessionStorage.getItem('mode') !== 'simulation') {
    initHardwareLink();
  }

  // Wake-up logic for mobile hotspot disconnects (on tab focus)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!activeWS || activeWS.readyState !== WebSocket.OPEN) {
        console.log('[HardwareLink] Visibility changed: Reclaiming session.');
        initHardwareLink();
      }
    }
  });

  // Global Navigator sync
  window.addEventListener('online', () => {
    console.log('[HardwareLink] Navigator Online: Forcing Link.');
    initHardwareLink();
  });
});
