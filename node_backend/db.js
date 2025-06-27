// Database initialization for Solana Escrow API
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('escrow.db');

// Initialize only the tables required for contracts and users
function initDb() {
  db.serialize(() => {
    // Table for escrow contracts
    db.run(`CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT UNIQUE,
      creator_id INTEGER,
      description TEXT,
      amount REAL,
      status TEXT,
      seller TEXT,
      buyer TEXT,
      vault TEXT,
      arbiter TEXT,
      programId TEXT,
      role TEXT,
      txid TEXT,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )`);
  });
}

module.exports = { db, initDb }; 