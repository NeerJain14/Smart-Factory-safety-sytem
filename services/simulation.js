const pool = require('../db');

class SimulationService {
    constructor() {
        this.isRunning = false;
        this.interval = null;
        this.activeUserId = null;

        this.envState = { temperature: 28.0, gas: 5.0, fire: 0, proximity: 100 };
        this.machinesState = {};
        this.envLimits = {}; /* loaded from env_thresholds */
        this.lastAlertTimes = {};
        this.lastSyncTime = 0;
    }

    start(userId) {
        if (this.isRunning) return;
        this.activeUserId = userId || null;
        this.isRunning = true;
        this.interval = setInterval(() => this.tick(), 500); // 4x Faster (500ms)
        console.log(`Simulation started for user_id: ${this.activeUserId}`);
    }

    resetState() {
        this.envState = { temperature: 28.0, gas: 5.0, fire: 0, proximity: 100 };
        this.machinesState = {};
        this.lastAlertTimes = {};
    }

    stop() {
        if (!this.isRunning) return;
        clearInterval(this.interval);
        this.isRunning = false;
        this.resetState();
        console.log("Simulation stopped.");
    }

    triggerManualEvent(type, targetId) {
        if (targetId) {
            const state = this.machinesState[targetId];
            if (state) {
                if (type === 'temperature') state.eventMode = 'heating';
                else if (type === 'current') state.eventMode = 'overload';
                state.eventTicks = 0;
            }
        } else {
            if (type === 'gas') this.envState.gas += 40;
            else if (type === 'fire') this.envState.fire = 1;
            else if (type === 'temperature') this.envState.temperature += 25;
            else if (type === 'proximity') this.envState.proximity = 5;
        }
    }

    async syncFromDB() {
        if (!this.activeUserId) return;
        
        // Throttling: Only sync from DB every 5 seconds (performance optimization)
        const now = Date.now();
        if (now - this.lastSyncTime < 5000) return;
        this.lastSyncTime = now;

        let conn;
        try {
            conn = await pool.getConnection();

            // Load env_thresholds
            const [envRows] = await conn.query('SELECT sensor_type, danger_threshold FROM env_thresholds WHERE user_id = ?', [this.activeUserId]);
            this.envLimits = {};
            envRows.forEach(r => { this.envLimits[r.sensor_type] = r.danger_threshold; });

            // Load machine_instances + thresholds
            const [mRows] = await conn.query(`
                SELECT m.instance_id, m.status, 
                       MAX(CASE WHEN t.sensor_type = 'temperature' THEN t.danger_threshold END) as temp_limit,
                       MAX(CASE WHEN t.sensor_type = 'current' THEN t.danger_threshold END) as current_limit
                FROM machine_instances m
                LEFT JOIN machine_thresholds t ON m.instance_id = t.instance_id
                WHERE m.user_id = ? AND m.deleted_at IS NULL
                GROUP BY m.instance_id
            `, [this.activeUserId]);

            mRows.forEach(m => {
                if (!this.machinesState[m.instance_id]) {
                    this.machinesState[m.instance_id] = { temperature: 30.0, current: 12.0, eventMode: 'none', eventTicks: 0 };
                }
                this.machinesState[m.instance_id].temp_limit = m.temp_limit || 50;
                this.machinesState[m.instance_id].current_limit = m.current_limit || 30;
                this.machinesState[m.instance_id].status = m.status;
            });
        } catch (err) {
            console.error('Sim sync err: ', err);
        } finally {
            if (conn) conn.release();
        }
    }

    async tick() {
        await this.syncFromDB();

        // Env logic
        this.envState.temperature += (28 - this.envState.temperature) * 0.1 + (Math.random() - 0.5);
        this.envState.gas += (5 - this.envState.gas) * 0.1 + (Math.random() - 0.5);
        this.envState.fire = 0;
        this.envState.proximity = 100 + (Math.random() * 10 - 5);
        if (Math.random() < 0.02) {
            if (Math.random() > 0.5) this.envState.gas += 30;
            else this.envState.fire = 1;
        }

        await this.logEnvData();

        // Machine logic
        for (const [id, state] of Object.entries(this.machinesState)) {
             switch (state.eventMode) {
                 case 'none':
                     state.temperature += (30 - state.temperature) * 0.1 + (Math.random() - 0.5);
                     state.current += (12 - state.current) * 0.1 + (Math.random() - 0.5);
                     break;
                 case 'heating':
                     state.temperature += 2;
                     if(++state.eventTicks > 15) state.eventMode = 'none';
                     break;
                 case 'overload':
                     state.current += 5;
                     if(++state.eventTicks > 5) state.eventMode = 'none';
                     break;
             }
             await this.logMachineData(parseInt(id), state);
        }
    }

    async logEnvData() {
        const factoryIngest = require('./factory_ingest');
        // Map simulation state to Dumb Node v2 keys
        const payload = {
            temp: this.envState.temperature,
            gas: this.envState.gas,
            flame: this.envState.fire === 1,
            proximity: this.envState.proximity
        };
        await factoryIngest.process(this.activeUserId, payload, true);
    }

    async logMachineData(id, state) {
        const factoryIngest = require('./factory_ingest');
        // Uniform format for Dumb Node v2
        const payload = {
            instance_id: id,
            temp: state.temperature,
            current: state.current
        };
        await factoryIngest.process(this.activeUserId, payload, true);
    }
}

module.exports = new SimulationService();
