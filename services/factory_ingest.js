const pool = require('../db');

class FactoryIngest {
    constructor() {
        this.lastAlertTimes = {}; // Cooldown for alerts: { "user_id-sensor_type": timestamp }
        this.cache = {}; // Cached thresholds: { "userId": { envLimits, mRows, timestamp } }
        this.lastLogTimes = {}; // Throttling DB writes: { "userId": lastTs }
    }

    /**
     * Unified processor for both physical hardware and simulation.
     * @param {number} userId - The target user
     * @param {object} rawData - JSON data from ESP32 or Sim engine
     * @param {boolean} isSimulation - Whether to flag as simulation
     */
    async process(userId, rawData, isSimulation = false) {
        if (!userId) return;
        const src = rawData.data || rawData;
        let conn;

        try {
            // 1. Fetch Current Thresholds (with Throttling / Caching)
            let cache = this.cache[userId];
            const now = Date.now();
            
            if (!cache || (now - cache.timestamp > 10000)) {
                conn = await pool.getConnection();
                const [envRows] = await conn.query('SELECT sensor_type, danger_threshold, warning_threshold FROM env_thresholds WHERE user_id = ?', [userId]);
                const envLimits = {};
                envRows.forEach(r => { 
                    envLimits[r.sensor_type] = { danger: r.danger_threshold, warn: r.warning_threshold }; 
                });

                const [mRows] = await conn.query(`
                    SELECT m.instance_id, m.instance_name,
                           MAX(CASE WHEN t.sensor_type = 'temperature' THEN t.danger_threshold END) as temp_danger,
                           MAX(CASE WHEN t.sensor_type = 'current' THEN t.danger_threshold END) as current_danger
                    FROM machine_instances m
                    LEFT JOIN machine_thresholds t ON m.instance_id = t.instance_id
                    WHERE m.user_id = ? AND m.deleted_at IS NULL
                    GROUP BY m.instance_id
                `, [userId]);

                cache = { envLimits, mRows, timestamp: now };
                this.cache[userId] = cache;
                conn.release();
                conn = null;
            }

            // 2. LOGGING THROTTLE: Prevent DB flooding on slow hotspots
            // We still return {success:true} for the WebSocket broadcast, but skip DB inserts
            const lastLog = this.lastLogTimes[userId] || 0;
            if (now - lastLog < 2500 && !isSimulation) {
                return { success: true, skipped: true };
            }
            this.lastLogTimes[userId] = now;

            if (!conn) conn = await pool.getConnection();

            // 3. Map & Log Environment Data
            const envMapping = [
                { type: 'temperature', val: src.temp !== undefined ? +src.temp : (src.env_temp_c !== undefined ? +src.env_temp_c : null) },
                { type: 'gas', val: (src.gas !== undefined ? +src.gas : (src.gas_adc !== undefined ? +src.gas_adc : null)) },
                { type: 'fire', val: (src.flame !== undefined ? (src.flame ? 1 : 0) : (src.flame_detected !== undefined ? (src.flame_detected ? 1 : 0) : (src.fire !== undefined ? +src.fire : null))) },
                { type: 'proximity', val: src.proximity !== undefined ? +src.proximity : null }
            ];

            for (const s of envMapping) {
                if (s.val === null || s.val === undefined) continue;
                
                const limits = envLimits[s.type] || { danger: 60, warn: 48 }; // safe defaults
                let status = 'safe';

                if (s.type === 'fire') {
                    // Fire is now binary: any detection is danger.
                    status = (s.val > 0) ? 'danger' : 'safe';
                } else if (s.type === 'proximity') {
                    if (s.val < limits.danger) status = 'danger';
                    else if (s.val < (limits.danger * 1.5)) status = 'warning';
                } else {
                    if (s.val >= limits.danger) status = 'danger';
                    else if (s.val >= limits.warn) status = 'warning';
                }

                await conn.query(
                    'INSERT INTO env_readings (user_id, sensor_type, reading_value, status, is_simulation) VALUES (?, ?, ?, ?, ?)',
                    [userId, s.type, s.val, status, isSimulation ? 1 : 0]
                );

                if (status === 'danger') {
                    await this.triggerAlert(conn, userId, null, s.type, s.val, limits.danger, isSimulation);
                }
            }

            // 3. Map & Log Machine Data (Targeting the first machine by default if not specified)
            const m0 = mRows[0];
            if (m0) {
                const machineMapping = [
                    { type: 'temperature', val: src.machine_temp_c !== undefined ? +src.machine_temp_c : null, limit: m0.temp_danger || 50 },
                    { type: 'current', val: src.current_a !== undefined ? +src.current_a : null, limit: m0.current_danger || 30 }
                ];

                for (const s of machineMapping) {
                    if (s.val === null || s.val === undefined) continue;
                    
                    let status = s.val >= s.limit ? 'danger' : (s.val >= s.limit * 0.8 ? 'warning' : 'safe');
                    await conn.query(
                        'INSERT INTO machine_readings (instance_id, sensor_type, reading_value, status, is_simulation) VALUES (?, ?, ?, ?, ?)',
                        [m0.instance_id, s.type, s.val, status, isSimulation ? 1 : 0]
                    );

                    if (status === 'danger') {
                        await this.triggerAlert(conn, userId, m0.instance_id, s.type, s.val, s.limit, isSimulation);
                    }
                }
            }

            return { success: true };
        } catch (err) {
            console.error('[FactoryIngest] Error:', err);
            return { success: false, error: err.message };
        } finally {
            if (conn) conn.release();
        }
    }

    async triggerAlert(conn, userId, instanceId, sensorType, val, limit, isSim) {
        const cooldown = 60 * 1000; // 1 minute
        const alertKey = `${userId}-${instanceId || 'env'}-${sensorType}`;
        const now = Date.now();

        if (!this.lastAlertTimes[alertKey] || (now - this.lastAlertTimes[alertKey]) > cooldown) {
            await conn.query(
                'INSERT INTO alerts (user_id, instance_id, sensor_type, reading_value, threshold_crossed, severity, is_simulation) VALUES (?, ?, ?, ?, ?, "danger", ?)',
                [userId, instanceId, sensorType, val, limit, isSim ? 1 : 0]
            );
            this.lastAlertTimes[alertKey] = now;
            console.log(`[FactoryIngest] Alert Triggered: ${sensorType} for User ${userId}`);
        }
    }
}

module.exports = new FactoryIngest();
