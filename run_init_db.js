const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function initDB() {
    console.log('Connecting to database server...');
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        multipleStatements: true // Allow executing multiple statements from the schema.sql file
    });

    try {
        const dbName = process.env.DB_NAME || 'smart_factory_db';
        console.log(`Recreating database \`${dbName}\`...`);
        // Drop database to start completely fresh
        await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
        await connection.query(`CREATE DATABASE \`${dbName}\``);
        await connection.query(`USE \`${dbName}\``);

        console.log('Applying schema from schema.sql...');
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf16le'); 
        
        await connection.query(schemaSql);
        
        console.log('Initial setup complete. Database is fresh!');

        // Create the default Admin user (Notice: system uses plain text passwords internally)
        await connection.query(
            `INSERT INTO users (username, email, password_hash, role, status, factory_id) VALUES (?, ?, ?, ?, ?, ?)`,
            ['Admin User', 'admin@gmail.com', 'Admin@123', 'admin', 'active', 'FACTORY-01']
        );
        console.log('Created default active admin user:\n - Email: admin@gmail.com\n - Password: Admin@123\n - Factory ID: FACTORY-01\n');
        
    } catch (err) {
        console.error('Error initializing database:', err);
    } finally {
        await connection.end();
        console.log('Done.');
        process.exit(0);
    }
}

initDB();
