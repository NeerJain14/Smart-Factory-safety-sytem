const express = require('express');
const router = express.Router();
const pool = require('../db');
const crypto = require('crypto');
const factoryIngest = require('../services/factory_ingest');
const simulationService = require('../services/simulation');
const { sendWorkerApprovalEmail } = require('../services/email_service');

function isSimReq(req) {
    const q = req.query || {};
    const b = req.body || {};
    return q.is_sim === 'true' || q.is_sim === true || b.is_sim === true || b.is_sim === 'true';
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

// ═══════════════ AUTH ═══════════════

router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await pool.query(
            'SELECT user_id, username as name, email, role, factory_id, status FROM users WHERE email = ? AND password_hash = ? AND deleted_at IS NULL',
            [email, password]
        );
        if (rows.length > 0) {
            const user = rows[0];

            // Check account status
            if (user.status === 'pending') {
                return res.status(403).json({ success: false, message: 'Your account is awaiting Admin approval. Please check back later.' });
            }
            if (user.status === 'rejected') {
                return res.status(403).json({ success: false, message: 'Your access request was denied by the factory Admin.' });
            }

            await pool.query('UPDATE users SET last_login_at = NOW() WHERE user_id = ?', [user.user_id]);
            res.json({ success: true, message: 'Logged in', user: { user_id: user.user_id, name: user.name, email: user.email, role: user.role, factory_id: user.factory_id } });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/auth/register', async (req, res) => {
    const { name, email, password, role, factory_id } = req.body;
    if (!name || !email || !password || !role || !factory_id) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    // Strict name validation (Alphabets/Spaces only)
    if (!/^[A-Za-z\s]+$/.test(name)) {
        return res.status(400).json({ success: false, message: 'Invalid name format. Only alphabets allowed.' });
    }

    // Gmail-only enforcement
    if (!email.toLowerCase().endsWith('@gmail.com')) {
        return res.status(400).json({ success: false, message: 'Only @gmail.com email addresses are accepted.' });
    }

    // Validate role
    if (role !== 'admin' && role !== 'worker') {
        return res.status(400).json({ success: false, message: 'Invalid role. Must be admin or worker.' });
    }

    let conn;
    try {
        conn = await pool.getConnection();

        if (role === 'admin') {
            // Check if factory_id is already taken by another admin
            const [existing] = await conn.query(
                "SELECT user_id FROM users WHERE factory_id = ? AND role = 'admin' AND deleted_at IS NULL",
                [factory_id]
            );
            if (existing.length > 0) {
                return res.status(409).json({ success: false, message: 'This Factory ID is already registered to another Admin.' });
            }

            // Create admin immediately as active
            const [result] = await conn.query(
                "INSERT INTO users (username, email, password_hash, role, factory_id, status) VALUES (?, ?, ?, 'admin', ?, 'active')",
                [name, email, password, factory_id]
            );
            const userId = result.insertId;

            // Provision default env thresholds
            const sensors = ['temperature', 'gas', 'fire', 'proximity'];
            for (const s of sensors) {
                await conn.query('INSERT INTO env_thresholds (user_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, ?, 50, 60)', [userId, s]);
            }

            res.json({ success: true, message: 'Admin account created! You can log in now.', user_id: userId });

        } else {
            // Worker registration
            // Check that the factory_id exists and belongs to an admin
            const [adminRows] = await conn.query(
                "SELECT user_id, email, username FROM users WHERE factory_id = ? AND role = 'admin' AND deleted_at IS NULL",
                [factory_id]
            );
            if (adminRows.length === 0) {
                return res.status(404).json({ success: false, message: 'Factory ID not found. Please verify the ID with your factory Admin.' });
            }

            const admin = adminRows[0];
            const approvalToken = crypto.randomBytes(48).toString('hex');

            // Create worker as pending
            const [result] = await conn.query(
                "INSERT INTO users (username, email, password_hash, role, factory_id, status, approval_token) VALUES (?, ?, ?, 'worker', ?, 'pending', ?)",
                [name, email, password, factory_id, approvalToken]
            );

            // Send approval email to admin
            const approveUrl = `${BASE_URL}/api/auth/approve/${approvalToken}`;
            const rejectUrl = `${BASE_URL}/api/auth/reject/${approvalToken}`;

            try {
                await sendWorkerApprovalEmail(admin.email, name, email, approveUrl, rejectUrl);
            } catch (emailErr) {
                console.error('[EMAIL] Failed to send approval email:', emailErr.message);
                // Registration still succeeds even if email fails — admin can check DB
            }

            res.json({ success: true, message: 'Registration submitted! Your account is pending approval by the factory Admin. You will be able to log in once approved.' });
        }
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            res.status(409).json({ success: false, message: 'This email address is already registered.' });
        } else {
            res.status(500).json({ error: err.message });
        }
    } finally {
        if (conn) conn.release();
    }
});

// ═══════════════ WORKER APPROVAL/REJECTION (Token-based) ═══════════════

router.get('/auth/approve/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const [rows] = await pool.query(
            "SELECT user_id, username, email, factory_id FROM users WHERE approval_token = ? AND status = 'pending'",
            [token]
        );
        if (rows.length === 0) {
            return res.send(buildResponsePage('Invalid or Expired Link', 'This approval link is no longer valid. The worker may have already been approved or rejected.', false));
        }

        const worker = rows[0];

        // Activate the worker
        await pool.query(
            "UPDATE users SET status = 'active', approval_token = NULL WHERE user_id = ?",
            [worker.user_id]
        );

        // Provision default env thresholds for the worker (they share factory data via factory_id)
        const [existing] = await pool.query('SELECT sensor_type FROM env_thresholds WHERE user_id = ?', [worker.user_id]);
        if (existing.length === 0) {
            const sensors = ['temperature', 'gas', 'fire', 'proximity'];
            for (const s of sensors) {
                await pool.query('INSERT INTO env_thresholds (user_id, sensor_type, warning_threshold, danger_threshold) VALUES (?, ?, 50, 60)', [worker.user_id, s]);
            }
        }

        res.send(buildResponsePage('Worker Approved', `<strong>${worker.username}</strong> (${worker.email}) has been granted access to your factory.`, true));
    } catch (err) {
        res.status(500).send(buildResponsePage('Error', 'An internal error occurred. Please try again.', false));
    }
});

router.get('/auth/reject/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const [rows] = await pool.query(
            "SELECT user_id, username, email FROM users WHERE approval_token = ? AND status = 'pending'",
            [token]
        );
        if (rows.length === 0) {
            return res.send(buildResponsePage('Invalid or Expired Link', 'This rejection link is no longer valid. The worker may have already been approved or rejected.', false));
        }

        const worker = rows[0];

        await pool.query(
            "UPDATE users SET status = 'rejected', approval_token = NULL WHERE user_id = ?",
            [worker.user_id]
        );

        res.send(buildResponsePage('Worker Rejected', `Access for <strong>${worker.username}</strong> (${worker.email}) has been denied.`, false));
    } catch (err) {
        res.status(500).send(buildResponsePage('Error', 'An internal error occurred. Please try again.', false));
    }
});

function buildResponsePage(title, message, isSuccess) {
    const color = isSuccess ? '#00e676' : '#ff1744';
    const icon = isSuccess ? '✓' : '✗';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>SFSS — ${title}</title>
    <style>
        body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0e14;font-family:'Segoe UI',Arial,sans-serif;color:#c5cdd8;}
        .card{background:#111820;border:1px solid #1e2a38;border-radius:8px;padding:48px 40px;max-width:420px;text-align:center;}
        .icon{font-size:56px;color:${color};margin-bottom:12px;}
        h1{font-size:20px;letter-spacing:2px;color:${color};margin:0 0 16px;}
        p{font-size:14px;line-height:1.7;color:#8a9ab0;margin:0;}
        p strong{color:#e0e8f0;}
        .sub{margin-top:24px;font-size:11px;color:#3a4a5a;letter-spacing:1px;}
    </style></head><body>
    <div class="card">
        <div class="icon">${icon}</div>
        <h1>${title.toUpperCase()}</h1>
        <p>${message}</p>
        <p class="sub">SMART FACTORY SAFETY SYSTEM</p>
    </div></body></html>`;
}

router.post('/auth/simulation', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT user_id, username as name, email, role FROM users WHERE email = ? LIMIT 1', ['sim@factory.com']);
        let user;
        if (rows.length > 0) user = rows[0];
        else {
            const [r] = await pool.query("INSERT INTO users (username, email, password_hash, role, status) VALUES (?, ?, ?, 'worker', 'active')", ['Simulation', 'sim@factory.com', 'sim']);
            user = { user_id: r.insertId, name: 'Simulation', email: 'sim@factory.com', role: 'worker' };
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
            SELECT a.alert_id, a.user_id, a.sensor_type as alert_type, a.severity as alert_level,
                   CONCAT('Limit crossed: ', a.sensor_type, ' @ ', ROUND(a.reading_value,1)) as alert_message,
                   a.triggered_at as timestamp,
                   a.instance_id as machine_id,
                   m.instance_name as machine_name,
                   a.reading_value as value,
                   a.sensor_type as sensor_name
            FROM alerts a
            LEFT JOIN machine_instances m ON a.instance_id = m.instance_id
            WHERE a.user_id = ? AND a.is_simulation = ?
            ORDER BY a.triggered_at DESC
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
