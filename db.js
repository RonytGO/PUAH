// db.js
const { Pool } = require('pg');

const pool = new Pool({
  // Cloud Run + Cloud SQL: socket is auto-mounted at /cloudsql/<INSTANCE_CONNECTION_NAME>
  host: `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`,
  user: process.env.DB_USER,     // e.g. appuser
  password: process.env.DB_PASS, // your strong password
  database: process.env.DB_NAME, // e.g. appdb
  max: 5,
  idleTimeoutMillis: 60_000
});

module.exports = { pool };
