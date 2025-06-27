// Solana Escrow API server
// Provides endpoints for contract management and user registration

require('dotenv').config();
const express = require('express');
const { db, initDb } = require('./db');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const { createOffer, joinOffer, fundEscrow, confirmEscrow, arbiterConfirm, arbiterCancel, mutualCancel, closeEscrow } = require('./solana');
const solanaWeb3 = require('@solana/web3.js');

app.use(express.json());
app.use(cors());

// Initialize the database tables
initDb();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Solana Telegram Escrow Node.js API running!' });
});

// --- USERS ---
// Register a new user with telegram_id and wallet_address
app.post('/users', (req, res) => {
  const { telegram_id, wallet_address } = req.body;
  if (!telegram_id || !wallet_address) {
    return res.status(400).json({ error: 'telegram_id and wallet_address required' });
  }
  db.run(
    'INSERT OR IGNORE INTO users (telegram_id, wallet_address) VALUES (?, ?)',
    [telegram_id, wallet_address],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, telegram_id, wallet_address });
    }
  );
});

// Get user info by telegram_id
app.get('/users/:telegram_id', (req, res) => {
  const { telegram_id } = req.params;
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegram_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  });
});

// --- CONTRACTS ---
// Create a new contract and store it in the database
app.post('/contracts', async (req, res) => {
  const { escrowAccount, vault, arbiter, buyer, seller, amount, description, txid, programId, role } = req.body;
  if (!escrowAccount || !vault || !arbiter || !amount || !txid || !role) {
    return res.status(400).json({ error: 'escrowAccount, vault, arbiter, amount, txid, role required' });
  }
  try {
    // Check if contract with this address already exists
    db.get('SELECT address FROM contracts WHERE address = ?', [escrowAccount], (err, row) => {
      if (err) {
        console.error('DB error:', err);
        return res.status(500).json({ error: err.message });
      }
      if (row) {
        return res.status(400).json({ error: `Contract with address ${escrowAccount} already exists. Try creating a new contract.` });
      }
      // Insert new contract
      db.run(
        'INSERT INTO contracts (address, vault, programId, arbiter, buyer, seller, amount, description, status, txid, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          escrowAccount,
          vault,
          programId || 'HAnbSMXSSBDysfSDWviYMwTD4h2vzRkp4Xd9rSP76kwe',
          arbiter,
          buyer || null,
          seller || null,
          amount,
          description || '',
          'created',
          txid,
          role
        ],
        function (err) {
          if (err) {
            console.error('DB error:', err);
            return res.status(500).json({ error: err.message });
          }
          res.json({
            id: this.lastID,
            address: escrowAccount,
            vault,
            arbiter,
            buyer: buyer || null,
            seller: seller || null,
            amount,
            description: description || '',
            status: 'created',
            txid,
            role
          });
        }
      );
    });
  } catch (e) {
    console.error('Create contract error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Join an existing contract (update buyer or seller)
app.post('/contracts/:address/join', async (req, res) => {
  const { address } = req.params;
  const { joiner, escrowAccount, programId, txid, role } = req.body;
  if (!joiner || !escrowAccount || !programId || !txid || !role) {
    return res.status(400).json({ error: 'joiner, escrowAccount, programId, txid, role required' });
  }
  // Update the contract with the joiner (buyer or seller)
  const fieldToUpdate = role === 'seller' ? 'buyer' : 'seller';
  db.run(
    `UPDATE contracts SET ${fieldToUpdate} = ?, status = 'initialized' WHERE address = ?`,
    [joiner, escrowAccount],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Get all contracts created by a user (by telegram_id)
app.get('/contracts/:telegram_id', (req, res) => {
  const { telegram_id } = req.params;
  db.get('SELECT id FROM users WHERE telegram_id = ?', [telegram_id], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.all('SELECT * FROM contracts WHERE creator_id = ?', [user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });
});

// Get contract by address
app.get('/contracts/by_address/:address', (req, res) => {
  const { address } = req.params;
  db.get('SELECT * FROM contracts WHERE address = ?', [address], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Contract not found' });
    res.json(row);
  });
});

// Get all contracts (for testing)
app.get('/contracts', (req, res) => {
  db.all('SELECT * FROM contracts', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Delete contract by address (only if status is 'created' or 'completed')
app.delete('/contracts/:address', (req, res) => {
  const { address } = req.params;
  db.get('SELECT status FROM contracts WHERE address = ?', [address], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Contract not found' });
    if (row.status !== 'created' && row.status !== 'completed') {
      return res.status(403).json({ error: 'Contract can only be deleted if status is "created" or "completed".' });
    }
    db.run('DELETE FROM contracts WHERE address = ?', [address], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

// Update contract details by address
app.put('/contracts/:address', (req, res) => {
  const { address } = req.params;
  const { description, amount, status } = req.body;
  db.run(
    `UPDATE contracts SET 
      description = COALESCE(?, description),
      amount = COALESCE(?, amount),
      status = COALESCE(?, status)
     WHERE address = ?`,
    [description, amount, status, address],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Contract not found' });
      res.json({ success: true });
    }
  );
});

// Update contract status and txid by address
app.put('/contracts/:address/status', (req, res) => {
  const { status, txid } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  db.run('UPDATE contracts SET status = ?, txid = ? WHERE address = ?', [status, txid, req.params.address], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Helper to validate Solana public keys
const isValidPubkey = (key) => {
  try {
    if (!key || typeof key !== 'string') return false;
    new solanaWeb3.PublicKey(key);
    return true;
  } catch (e) {
    return false;
  }
};

// Contract funding endpoint
app.post('/contracts/:address/fund', async (req, res) => {
  const { buyerSecretKey, escrowAccount, vault, programId, connectionUrl } = req.body;
  if (!buyerSecretKey || !escrowAccount || !vault || !programId || !connectionUrl) {
    return res.status(400).json({ error: 'buyerSecretKey, escrowAccount, vault, programId, connectionUrl required' });
  }
  if (!isValidPubkey(escrowAccount)) return res.status(400).json({ error: 'Invalid escrowAccount pubkey' });
  if (!isValidPubkey(vault)) return res.status(400).json({ error: 'Invalid vault pubkey' });
  if (!isValidPubkey(programId)) return res.status(400).json({ error: 'Invalid programId pubkey' });
  try {
    const buyerKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(buyerSecretKey));
    const escrowAccountPubkey = new solanaWeb3.PublicKey(escrowAccount);
    const vaultPubkey = new solanaWeb3.PublicKey(vault);
    const signature = await fundEscrow({
      connectionUrl,
      programId,
      buyerKeypair,
      escrowAccountPubkey,
      vaultPubkey
    });
    // Update status to 'funded'
    db.run('UPDATE contracts SET status = ? WHERE address = ?', ['funded', escrowAccount], function (err) {
      if (err) console.error('DB error updating status:', err);
    });
    res.json({ solanaSignature: signature });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Seller confirmation endpoint
app.post('/contracts/:address/seller_confirm', async (req, res) => {
  const { sellerSecretKey, escrowAccount, programId, connectionUrl } = req.body;
  if (!sellerSecretKey || !escrowAccount || !programId || !connectionUrl) {
    return res.status(400).json({ error: 'sellerSecretKey, escrowAccount, programId, connectionUrl required' });
  }
  if (!isValidPubkey(escrowAccount)) return res.status(400).json({ error: 'Invalid escrowAccount pubkey' });
  if (!isValidPubkey(programId)) return res.status(400).json({ error: 'Invalid programId pubkey' });
  try {
    const sellerKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(sellerSecretKey));
    const escrowAccountPubkey = new solanaWeb3.PublicKey(escrowAccount);
    // Call your on-chain logic here (not shown)
    // Update status to 'seller_confirmed'
    db.run('UPDATE contracts SET status = ? WHERE address = ?', ['seller_confirmed', escrowAccount], function (err) {
      if (err) console.error('DB error updating status:', err);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Buyer confirmation endpoint
app.post('/contracts/:address/buyer_confirm', async (req, res) => {
  const { buyerSecretKey, escrowAccount, programId, connectionUrl } = req.body;
  if (!buyerSecretKey || !escrowAccount || !programId || !connectionUrl) {
    return res.status(400).json({ error: 'buyerSecretKey, escrowAccount, programId, connectionUrl required' });
  }
  if (!isValidPubkey(escrowAccount)) return res.status(400).json({ error: 'Invalid escrowAccount pubkey' });
  if (!isValidPubkey(programId)) return res.status(400).json({ error: 'Invalid programId pubkey' });
  try {
    const buyerKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(buyerSecretKey));
    const escrowAccountPubkey = new solanaWeb3.PublicKey(escrowAccount);
    // Call your on-chain logic here (not shown)
    // Update status to 'completed'
    db.run('UPDATE contracts SET status = ? WHERE address = ?', ['completed', escrowAccount], function (err) {
      if (err) console.error('DB error updating status:', err);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Arbiter confirmation endpoint
app.post('/contracts/:address/arbiter_confirm', async (req, res) => {
  const { arbiterSecretKey, escrowAccount, vault, seller, programId, connectionUrl } = req.body;
  if (!arbiterSecretKey || !escrowAccount || !vault || !seller || !programId || !connectionUrl) {
    return res.status(400).json({ error: 'arbiterSecretKey, escrowAccount, vault, seller, programId, connectionUrl required' });
  }
  if (!isValidPubkey(escrowAccount)) return res.status(400).json({ error: 'Invalid escrowAccount pubkey' });
  if (!isValidPubkey(vault)) return res.status(400).json({ error: 'Invalid vault pubkey' });
  if (!isValidPubkey(seller)) return res.status(400).json({ error: 'Invalid seller pubkey' });
  if (!isValidPubkey(programId)) return res.status(400).json({ error: 'Invalid programId pubkey' });
  try {
    const arbiterKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(arbiterSecretKey));
    const escrowAccountPubkey = new solanaWeb3.PublicKey(escrowAccount);
    const vaultPubkey = new solanaWeb3.PublicKey(vault);
    const sellerPubkey = new solanaWeb3.PublicKey(seller);
    const signature = await arbiterConfirm({
      connectionUrl,
      programId,
      arbiterKeypair,
      escrowAccountPubkey,
      vaultPubkey,
      sellerPubkey
    });
    // Update status to 'completed'
    db.run('UPDATE contracts SET status = ? WHERE address = ?', ['completed', escrowAccount], function (err) {
      if (err) console.error('DB error updating status:', err);
    });
    res.json({ solanaSignature: signature });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Arbiter cancel endpoint
app.post('/contracts/:address/arbiter_cancel', async (req, res) => {
  const { arbiterSecretKey, escrowAccount, vault, buyer, programId, connectionUrl } = req.body;
  if (!arbiterSecretKey || !escrowAccount || !vault || !buyer || !programId || !connectionUrl) {
    return res.status(400).json({ error: 'arbiterSecretKey, escrowAccount, vault, buyer, programId, connectionUrl required' });
  }
  if (!isValidPubkey(escrowAccount)) return res.status(400).json({ error: 'Invalid escrowAccount pubkey' });
  if (!isValidPubkey(vault)) return res.status(400).json({ error: 'Invalid vault pubkey' });
  if (!isValidPubkey(buyer)) return res.status(400).json({ error: 'Invalid buyer pubkey' });
  if (!isValidPubkey(programId)) return res.status(400).json({ error: 'Invalid programId pubkey' });
  try {
    const arbiterKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(arbiterSecretKey));
    const escrowAccountPubkey = new solanaWeb3.PublicKey(escrowAccount);
    const vaultPubkey = new solanaWeb3.PublicKey(vault);
    const buyerPubkey = new solanaWeb3.PublicKey(buyer);
    const signature = await arbiterCancel({
      connectionUrl,
      programId,
      arbiterKeypair,
      escrowAccountPubkey,
      vaultPubkey,
      buyerPubkey
    });
    // Update status to 'cancelled'
    db.run('UPDATE contracts SET status = ? WHERE address = ?', ['cancelled', escrowAccount], function (err) {
      if (err) console.error('DB error updating status:', err);
    });
    res.json({ solanaSignature: signature });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mutual cancel endpoint
app.post('/contracts/:address/mutual_cancel', async (req, res) => {
  const { buyerSecretKey, sellerSecretKey, escrowAccount, vault, programId, connectionUrl } = req.body;
  if (!buyerSecretKey || !sellerSecretKey || !escrowAccount || !vault || !programId || !connectionUrl) {
    return res.status(400).json({ error: 'buyerSecretKey, sellerSecretKey, escrowAccount, vault, programId, connectionUrl required' });
  }
  if (!isValidPubkey(escrowAccount)) return res.status(400).json({ error: 'Invalid escrowAccount pubkey' });
  if (!isValidPubkey(vault)) return res.status(400).json({ error: 'Invalid vault pubkey' });
  if (!isValidPubkey(programId)) return res.status(400).json({ error: 'Invalid programId pubkey' });
  try {
    const buyerKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(buyerSecretKey));
    const sellerKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(sellerSecretKey));
    const escrowAccountPubkey = new solanaWeb3.PublicKey(escrowAccount);
    const vaultPubkey = new solanaWeb3.PublicKey(vault);
    const signature = await mutualCancel({
      connectionUrl,
      programId,
      buyerKeypair,
      sellerKeypair,
      escrowAccountPubkey,
      vaultPubkey
    });
    // Update status to 'cancelled'
    db.run('UPDATE contracts SET status = ? WHERE address = ?', ['cancelled', escrowAccount], function (err) {
      if (err) console.error('DB error updating status:', err);
    });
    res.json({ solanaSignature: signature });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Close contract endpoint
app.post('/contracts/:address/close', async (req, res) => {
  const { closerSecretKey, escrowAccount, programId, connectionUrl } = req.body;
  if (!closerSecretKey || !escrowAccount || !programId || !connectionUrl) {
    return res.status(400).json({ error: 'closerSecretKey, escrowAccount, programId, connectionUrl required' });
  }
  if (!isValidPubkey(escrowAccount)) return res.status(400).json({ error: 'Invalid escrowAccount pubkey' });
  if (!isValidPubkey(programId)) return res.status(400).json({ error: 'Invalid programId pubkey' });
  try {
    const closerKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(closerSecretKey));
    const escrowAccountPubkey = new solanaWeb3.PublicKey(escrowAccount);
    // Call your on-chain logic here (not shown)
    // Update status to 'closed'
    db.run('UPDATE contracts SET status = ? WHERE address = ?', ['closed', escrowAccount], function (err) {
      if (err) console.error('DB error updating status:', err);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all contracts for a user by wallet address (buyer or seller)
app.get('/contracts/user/:walletAddress', (req, res) => {
  const { walletAddress } = req.params;
  db.all(
    'SELECT * FROM contracts WHERE buyer = ? OR seller = ?',
    [walletAddress, walletAddress],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// Delete all contracts (for development/testing only)
app.delete('/contracts/clear', (req, res) => {
  db.run('DELETE FROM contracts', function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

app.listen(3000, '0.0.0.0', () => {
  console.log(`API server running on port ${PORT}`);
}); 