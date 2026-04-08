const express = require('express');
const router = express.Router();
const pool = require('../db');
const factoryIngest = require('../services/factory_ingest');
const simulationService = require('../services/simulation');

function isSimReq(req) {
    const q = req.query || {};
    const b = req.body || {};
    return q.is_sim === 'true' || q.is_sim === true || b.is_sim === true || b.is_sim === 'true';
}

// ═══════════════ AUTH ═══════════════

router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.query(
            'SELECT user_id, username as name, email, role FROM users WHERE email = ? AND password_hash = ? AND deleted_at IS NULL',
            [email, password]
        );
        if (rows.length > 0) {
            const user = rows[0];
            await pool.query('UPDATE users SET last_login_at = NOW() WHERE user_id = ?', [user.user_id]);
            res.json({ success: true, message: 'Logged in', user });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/auth/register', async (req, res) => {
    const { name, email, password, role = 'operator' } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: 'Missing fields' });
    let conn;
    try {
        conn = await pool.getConnection();
        const [result] = await conn.query(
            'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
            [name, email, password, role]
        );
        const userId = result.insertId;

        // Provision default limits
        const sensors = ['temperature', 'gas', 'fire', 'proximity'];
        for (const s of sensors) {
            await conn.query(`INSERT INTO env_thresholds (user_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, ?, 50, 60)`, [userId, s]);
        }
        res.json({ success: true, message: 'Registered successfully', user_id: userId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') res.status(409).json({ success: false, message: 'Email exists' });
        else res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

router.post('/auth/simulation', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT user_id, username as name, email, role FROM users WHERE email = ? LIMIT 1', ['sim@factory.com']);
        let user;
        if (rows.length > 0) user = rows[0];
        else {
            const [r] = await pool.query('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)', ['Simulation', 'sim@factory.com', 'sim', 'operator']);
            user = { user_id: r.insertId, name: 'Simulation', email: 'sim@factory.com', role: 'operator' };
        }

        const [mRows] = await pool.query('SELECT instance_id FROM machine_instances WHERE user_id = ?', [user.user_id]);
        if (mRows.length === 0) {
            const [tRows] = await pool.query('SELECT machine_type_id FROM machine_types LIMIT 1');
            if (tRows.length > 0) {
                const [ins] = await pool.query(
                    'INSERT INTO machine_instances (user_id, machine_type_id, instance_name, physical_location, status) VALUES (?, ?, "Simulated Press", "Sim Sector", "online")',
                    [user.user_id, tRows[0].machine_type_id]
                );
                await pool.query('INSERT INTO machine_thresholds (instance_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, "temperature", 80, 90)', [ins.insertId]);
                await pool.query('INSERT INTO machine_thresholds (instance_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, "current", 15, 20)', [ins.insertId]);
            }
        }
        
        // Ensure default env_thresholds exist for the simulation user
        const [eRows] = await pool.query('SELECT sensor_type FROM env_thresholds WHERE user_id = ?', [user.user_id]);
        if (eRows.length === 0) {
            const sensors = ['temperature', 'gas', 'fire', 'proximity'];
            for (const s of sensors) {
                await pool.query('INSERT INTO env_thresholds (user_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, ?, 50, 60)', [user.user_id, s]);
            }
        }
        
        const clientUser = { ...user, role: 'simulation' };
        simulationService.start(user.user_id);
        res.json({ success: true, message: 'Simulation mode entered', user: clientUser });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════ ENVIRONMENTS ═══════════════

router.get('/environments', async (req, res) => {
    const { user_id } = req.query;
    try {
        const sql = `
            SELECT 
                1 as env_id, 
                ? as user_id, 
                'Global Floor' as env_name, 
                COALESCE(MAX(CASE WHEN sensor_type = 'temperature' THEN danger_threshold END), 60.0) as temperature_limit,
                COALESCE(MAX(CASE WHEN sensor_type = 'gas' THEN danger_threshold END), 40.0) as gas_limit,
                COALESCE(MAX(CASE WHEN sensor_type = 'fire' THEN danger_threshold END), 1.0) as fire_limit
            FROM env_thresholds
            WHERE user_id = ?
        `;
        const [rows] = await pool.query(sql, [user_id, user_id]);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/environments/:id', async (req, res) => {
    const { user_id, temperature_limit, gas_limit, fire_limit } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    try {
        if (temperature_limit !== undefined) {
            await pool.query(`INSERT INTO env_thresholds (user_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, 'temperature', ?, ?) ON DUPLICATE KEY UPDATE warning_threshold=VALUES(warning_threshold), danger_threshold=VALUES(danger_threshold)`, [user_id, temperature_limit * 0.8, temperature_limit]);
        }
        if (gas_limit !== undefined) {
            await pool.query(`INSERT INTO env_thresholds (user_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, 'gas', ?, ?) ON DUPLICATE KEY UPDATE warning_threshold=VALUES(warning_threshold), danger_threshold=VALUES(danger_threshold)`, [user_id, gas_limit * 0.8, gas_limit]);
        }
        if (fire_limit !== undefined) {
            await pool.query(`INSERT INTO env_thresholds (user_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, 'fire', ?, ?) ON DUPLICATE KEY UPDATE warning_threshold=VALUES(warning_threshold), danger_threshold=VALUES(danger_threshold)`, [user_id, fire_limit * 0.8, fire_limit]);
        }
        res.json({ success: true, message: 'Environment updated globally' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════ MACHINES ═══════════════

router.get('/machines', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    try {
        const sql = `
            SELECT 
                m.instance_id as machine_id, 
                m.instance_name as machine_name, 
                m.physical_location as location, 
                m.status,
                mt.type_name as machine_type,
                COALESCE(MAX(CASE WHEN t.sensor_type = 'temperature' THEN t.danger_threshold END), 50.0) as temp_limit,
                COALESCE(MAX(CASE WHEN t.sensor_type = 'current' THEN t.danger_threshold END), 30.0) as current_limit
            FROM machine_instances m
            LEFT JOIN machine_types mt ON m.machine_type_id = mt.machine_type_id
            LEFT JOIN machine_thresholds t ON m.instance_id = t.instance_id
            WHERE m.user_id = ? AND m.deleted_at IS NULL
            GROUP BY m.instance_id
        `;
        const [rows] = await pool.query(sql, [user_id]);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/machines', async (req, res) => {
    const { user_id, machine_name, machine_type = 'General', location, temp_limit = 50.0, current_limit = 30.0 } = req.body;
    if (!machine_name || !user_id) return res.status(400).json({ error: 'user_id and machine_name are required' });
    
    let conn;
    try {
        conn = await pool.getConnection();
        
        let [tRows] = await conn.query('SELECT machine_type_id FROM machine_types WHERE type_name = ?', [machine_type]);
        let typeId;
        if (tRows.length === 0) {
            const [tIns] = await conn.query('INSERT INTO machine_types (type_name) VALUES (?)', [machine_type]);
            typeId = tIns.insertId;
        } else {
            typeId = tRows[0].machine_type_id;
        }

        const [mIns] = await conn.query(
            'INSERT INTO machine_instances (user_id, machine_type_id, instance_name, physical_location, status) VALUES (?, ?, ?, ?, "online")',
            [user_id, typeId, machine_name, location || '']
        );
        const newId = mIns.insertId;

        await conn.query('INSERT INTO machine_thresholds (instance_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, "temperature", ?, ?)', [newId, temp_limit*0.8, temp_limit]);
        await conn.query('INSERT INTO machine_thresholds (instance_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, "current", ?, ?)', [newId, current_limit*0.8, current_limit]);
        
        res.json({ success: true, data: { machine_id: newId } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

router.put('/machines/:id', async (req, res) => {
    const machineId = req.params.id;
    const { user_id, machine_name, location, status, temp_limit, current_limit } = req.body;
    let mappedStatus = 'online';
    if (status === 'inactive' || status === 'offline') mappedStatus = 'offline';

    let conn;
    try {
        conn = await pool.getConnection();
        
        let typeId = null;
        if (req.body.machine_type) {
            let [tRows] = await conn.query('SELECT machine_type_id FROM machine_types WHERE type_name = ?', [req.body.machine_type]);
            if (tRows.length === 0) {
                const [tIns] = await conn.query('INSERT INTO machine_types (type_name) VALUES (?)', [req.body.machine_type]);
                typeId = tIns.insertId;
            } else {
                typeId = tRows[0].machine_type_id;
            }
        }

        const sets = ['instance_name=?', 'physical_location=?', 'status=?'];
        const args = [machine_name, location, mappedStatus];
        if (typeId) {
            sets.push('machine_type_id=?');
            args.push(typeId);
        }
        args.push(machineId, user_id);

        await conn.query(`UPDATE machine_instances SET ${sets.join(', ')} WHERE instance_id=? AND user_id=?`, args);
        
        if (temp_limit !== undefined) {
             const [tRes] = await conn.query('UPDATE machine_thresholds SET danger_threshold=?, warning_threshold=? WHERE instance_id=? AND sensor_type="temperature"', [temp_limit, temp_limit*0.8, machineId]);
             if (tRes.affectedRows === 0) {
                 await conn.query('INSERT INTO machine_thresholds (instance_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, "temperature", ?, ?)', [machineId, temp_limit*0.8, temp_limit]);
             }
        }
        if (current_limit !== undefined) {
             const [cRes] = await conn.query('UPDATE machine_thresholds SET danger_threshold=?, warning_threshold=? WHERE instance_id=? AND sensor_type="current"', [current_limit, current_limit*0.8, machineId]);
             if (cRes.affectedRows === 0) {
                 await conn.query('INSERT INTO machine_thresholds (instance_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, "current", ?, ?)', [machineId, current_limit*0.8, current_limit]);
             }
        }
        
        res.json({ success: true, message: 'Machine updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// ═══════════════ ALERTS ═══════════════

router.get('/alerts', async (req, res) => {
    const { user_id } = req.query;
    const isSim = isSimReq(req) ? 1 : 0;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    try {
        const sql = `
            SELECT alert_id, user_id, sensor_type as alert_type, severity as alert_level,
                   CONCAT('Limit crossed: ', sensor_type, ' @ ', ROUND(reading_value,1)) as alert_message,
                   triggered_at as timestamp,
                   instance_id as machine_id,
                   reading_value as value,
                   sensor_type as sensor_name
            FROM alerts
            WHERE user_id = ? AND is_simulation = ?
            ORDER BY triggered_at DESC
            LIMIT 100
        `;
        const [rows] = await pool.query(sql, [user_id, isSim]);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════ ACTUATORS ═══════════════

router.get('/actuators', async (req, res) => {
    // Legacy mock returning default actuators
    res.json({ success: true, data: [
        { actuator_id: 1, actuator_type: 'cooling_fan', actuator_name: 'Cooling Fan', status: 'active' },
        { actuator_id: 2, actuator_type: 'power_cutoff', actuator_name: 'System Shutdown', status: 'active' },
        { actuator_id: 3, actuator_type: 'lcd_display', actuator_name: 'LCD Display', status: 'active' },
    ]});
});

router.get('/actuators/logs', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    try {
        const [rows] = await pool.query(`
            SELECT log_id, user_id, action, cause as trigger_type, triggered_at as timestamp, actuator_type, actuator_type as actuator_name
            FROM actuator_logs
            WHERE user_id = ?
            ORDER BY triggered_at DESC
            LIMIT 50
        `, [user_id]);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/actuators/control', async (req, res) => {
    const { user_id, actuator_id, action, trigger_type = 'manual_command' } = req.body;
    let type = 'cooling_fan';
    if(actuator_id == 2) type = 'power_cutoff';
    if(actuator_id == 3) type = 'lcd_display';

    try {
        await pool.query(
            `INSERT INTO actuator_logs (user_id, actuator_type, action, cause) VALUES (?, ?, ?, ?)`,
            [user_id, type, action, trigger_type]
        );
        res.json({ success: true, message: 'Action logged' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════ SENSORS (Flat Telemetry Bridge) ═══════════════

router.get('/sensors', async (req, res) => {
    const { user_id } = req.query;
    try {
        const [envRows] = await pool.query("SELECT sensor_type as sensor_name, sensor_type FROM env_thresholds WHERE user_id=?", [user_id]);
        const [macRows] = await pool.query(`
            SELECT m.sensor_type as sensor_name, m.sensor_type, i.instance_id as machine_id, i.instance_name as machine_name 
            FROM machine_thresholds m JOIN machine_instances i ON m.instance_id=i.instance_id WHERE i.user_id=?
        `, [user_id]);
        res.json({ success: true, data: [...envRows, ...macRows] });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sensors/latest', async (req, res) => {
    const { user_id } = req.query;
    const isSim = isSimReq(req) ? 1 : 0;
    try {
        const sql = `
            SELECT 
                captured_at as timestamp,
                CASE WHEN sensor_type = 'temperature' THEN reading_value ELSE NULL END as temperature_value,
                CASE WHEN sensor_type = 'gas' THEN reading_value ELSE NULL END as gas_value,
                CASE WHEN sensor_type = 'current' THEN reading_value ELSE NULL END as current_value,
                CASE WHEN sensor_type = 'fire' THEN reading_value ELSE NULL END as fire_status,
                CASE WHEN sensor_type = 'proximity' THEN reading_value ELSE NULL END as proximity_status,
                sensor_type,
                sensor_type as sensor_name,
                NULL as machine_id
            FROM env_readings
            WHERE user_id = ? AND is_simulation = ? AND captured_at = (SELECT MAX(captured_at) FROM env_readings WHERE user_id = ? AND is_simulation = ?)

            UNION ALL

            SELECT 
                r.captured_at as timestamp,
                CASE WHEN r.sensor_type = 'temperature' THEN r.reading_value ELSE NULL END as temperature_value,
                NULL as gas_value,
                CASE WHEN r.sensor_type = 'current' THEN r.reading_value ELSE NULL END as current_value,
                NULL as fire_status,
                NULL as proximity_status,
                r.sensor_type,
                r.sensor_type as sensor_name,
                r.instance_id as machine_id
            FROM machine_readings r
            JOIN machine_instances i ON r.instance_id = i.instance_id
            WHERE i.user_id = ? AND r.is_simulation = ?
              AND r.captured_at = (SELECT MAX(captured_at) FROM machine_readings r2 WHERE r2.instance_id = r.instance_id AND r2.is_simulation = ?)
        `;
        const [rows] = await pool.query(sql, [user_id, isSim, user_id, isSim, user_id, isSim, isSim]);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sensors/history', async (req, res) => {
    const { user_id, limit = 500 } = req.query;
    const isSim = isSimReq(req) ? 1 : 0;
    try {
        const [rows] = await pool.query(`
            SELECT 
                captured_at as timestamp,
                CASE WHEN sensor_type = 'temperature' THEN reading_value ELSE NULL END as temperature_value,
                CASE WHEN sensor_type = 'gas' THEN reading_value ELSE NULL END as gas_value,
                CASE WHEN sensor_type = 'current' THEN reading_value ELSE NULL END as current_value,
                CASE WHEN sensor_type = 'fire' THEN reading_value ELSE NULL END as fire_status,
                CASE WHEN sensor_type = 'proximity' THEN reading_value ELSE NULL END as proximity_status,
                sensor_type, sensor_type as sensor_name, NULL as machine_id
            FROM env_readings WHERE user_id = ? AND is_simulation = ?
            UNION ALL
            SELECT 
                r.captured_at as timestamp,
                CASE WHEN r.sensor_type = 'temperature' THEN r.reading_value ELSE NULL END as temperature_value,
                NULL as gas_value, CASE WHEN r.sensor_type = 'current' THEN r.reading_value ELSE NULL END as current_value,
                NULL as fire_status, NULL as proximity_status,
                r.sensor_type, r.sensor_type as sensor_name, r.instance_id as machine_id
            FROM machine_readings r JOIN machine_instances i ON r.instance_id = i.instance_id 
            WHERE i.user_id = ? AND r.is_simulation = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `, [user_id, isSim, user_id, isSim, parseInt(limit)]);
        res.json({ success: true, data: rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sensors/analytics/24h', async (req, res) => {
    const { user_id } = req.query;
    const isSim = isSimReq(req) ? 1 : 0;
    try {
        const [rows] = await pool.query(`
            SELECT 
                captured_at as timestamp,
                CASE WHEN sensor_type = 'temperature' THEN reading_value ELSE NULL END as temperature_value,
                CASE WHEN sensor_type = 'gas' THEN reading_value ELSE NULL END as gas_value,
                CASE WHEN sensor_type = 'current' THEN reading_value ELSE NULL END as current_value,
                sensor_type, sensor_type as sensor_name, NULL as machine_id
            FROM env_readings WHERE user_id = ? AND is_simulation = ? AND captured_at >= (NOW() - INTERVAL 1 DAY)
            UNION ALL
            SELECT 
                r.captured_at as timestamp,
                CASE WHEN r.sensor_type = 'temperature' THEN r.reading_value ELSE NULL END as temperature_value,
                NULL as gas_value, CASE WHEN r.sensor_type = 'current' THEN r.reading_value ELSE NULL END as current_value,
                r.sensor_type, r.sensor_type as sensor_name, r.instance_id as machine_id
            FROM machine_readings r JOIN machine_instances i ON r.instance_id = i.instance_id 
            WHERE i.user_id = ? AND r.is_simulation = ? AND r.captured_at >= (NOW() - INTERVAL 1 DAY)
            ORDER BY timestamp ASC
            LIMIT 5000
        `, [user_id, isSim, user_id, isSim]);
        res.json({ success: true, data: rows });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════ SIMULATION ═══════════════
router.delete('/simulation/reset', async (req, res) => {
    const { user_id } = req.query;
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        await conn.query('DELETE FROM machine_readings WHERE is_simulation = 1 AND instance_id IN (SELECT instance_id FROM machine_instances WHERE user_id = ?)', [user_id]);
        await conn.query('DELETE FROM env_readings WHERE is_simulation = 1 AND user_id = ?', [user_id]);
        await conn.query('DELETE FROM alerts WHERE is_simulation = 1 AND user_id = ?', [user_id]);
        await conn.query('DELETE FROM actuator_logs WHERE user_id = ?', [user_id]);
        await conn.commit();
        res.json({ success: true, message: 'Simulation data reset' });
    } catch (err) {
        if (conn) await conn.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

router.post('/simulation/trigger', (req, res) => {
    const { type, machine_id } = req.body;
    simulationService.triggerManualEvent(type, machine_id);
    res.json({ success: true, message: `Manual trigger ${type} activated` });
});

router.post('/simulation/stop', (req, res) => {
    simulationService.stop();
    res.json({ success: true, message: 'Simulation Stopped' });
});

// ═══════════════ RULES & LOGIC (Smart Factory Safety Engine) ═══════════════

router.get('/control/rules', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    try {
        const [rows] = await pool.query('SELECT * FROM control_rules WHERE user_id = ?', [user_id]);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/control/rules/:id', async (req, res) => {
    const { user_id, threshold_val, is_enabled } = req.body;
    try {
        await pool.query(
            'UPDATE control_rules SET threshold_val = ?, is_enabled = ? WHERE rule_id = ? AND user_id = ?',
            [threshold_val, is_enabled, req.params.id, user_id]
        );
        res.json({ success: true, message: 'Rule updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/control/config', async (req, res) => {
    const { user_id } = req.query;
    try {
        const [rows] = await pool.query('SELECT * FROM system_config WHERE user_id = ?', [user_id]);
        if (rows.length === 0) {
            await pool.query('INSERT INTO system_config (user_id, auto_pilot) VALUES (?, 1)', [user_id]);
            return res.json({ success: true, data: { user_id, auto_pilot: 1 } });
        }
        res.json({ success: true, data: rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/control/config', async (req, res) => {
    const { user_id, auto_pilot } = req.body;
    try {
        await pool.query(
            'INSERT INTO system_config (user_id, auto_pilot) VALUES (?, ?) ON DUPLICATE KEY UPDATE auto_pilot = VALUES(auto_pilot)',
            [user_id, auto_pilot ? 1 : 0]
        );
        res.json({ success: true, message: 'System configuration updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
