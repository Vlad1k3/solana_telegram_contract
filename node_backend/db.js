// Database initialization for Solana Escrow API
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('escrow.db');

// Initialize only the tables required for contracts and users
function initDb() {
  db.serialize(() => {
    // Table for users
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      wallet_address TEXT
    )`);

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
      mint TEXT,
      fee_collector TEXT,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )`, (createErr) => {
      if (createErr) {
        console.error('Error creating contracts table:', createErr);
      }
      
      // Добавить недостающие колонки в существующую таблицу
      db.run(`ALTER TABLE contracts ADD COLUMN fee_collector TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
          console.log('fee_collector column already exists or added');
        } else if (!err) {
          console.log('Added fee_collector column');
        }
      });

      db.run(`ALTER TABLE contracts ADD COLUMN mint TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
          console.log('mint column already exists or added');
        } else if (!err) {
          console.log('Added mint column');
        }
      });

      db.run(`ALTER TABLE contracts ADD COLUMN random_seed TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
          console.log('random_seed column already exists or added');
        } else if (!err) {
          console.log('Added random_seed column');
        }
      });
    });
  });
}

module.exports = { db, initDb }; 