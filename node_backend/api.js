// Solana Escrow API server
// Provides endpoints for contract management and user registration

require('dotenv').config();
const express = require('express');
const { db, initDb } = require('./db');
const cors = require('cors');
const fs = require('fs');
const solanaWeb3 = require('@solana/web3.js');
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
const {
  createOffer,
  joinOffer,
  fundEscrow,
  confirmEscrow,
  arbiterConfirm,
  arbiterCancel,
  mutualCancel,
  closeEscrow,
  getEscrowInfo
} = require('./solana');
const app = express();
const PORT = process.env.PORT || 3000;

// Загружаем fee_payer ключ
let feePayerKeypair;
try {
  const feePayerSecretKey = JSON.parse(fs.readFileSync('./fee_payer.json', 'utf8'));
  feePayerKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(feePayerSecretKey));
  console.log('Fee payer loaded:', feePayerKeypair.publicKey.toString());
} catch (error) {
  console.error('Error loading fee payer:', error);
  process.exit(1);
}

// Middleware to bypass ngrok warning page
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// CORS configuration
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  exposedHeaders: ['Content-Length', 'X-Total-Count']
};
app.use(cors(corsOptions));

app.use(express.json());

// Initialize the database tables
initDb();

// Health check endpoint with ngrok header
app.get('/healthcheck', (req, res) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ngrok: process.env.NGROK || 'local'
  });
});

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
  console.log('CREATE CONTRACT BODY:', req.body);
  const { escrowAccount, vault, arbiter, buyer, seller, amount, description, txid, programId, role, mint } = req.body;
  if (!escrowAccount || !vault || !arbiter || !amount || !txid || !role) {
    return res.status(400).json({ error: 'escrowAccount, vault, arbiter, amount, txid, role required' });
  }
  
  // fee_collector всегда будет нашим fee_payer аккаунтом
  const feeCollector = feePayerKeypair.publicKey.toString();
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
      // Insert new contract (добавляем mint и fee_collector)
      db.run(
        'INSERT INTO contracts (address, vault, programId, arbiter, buyer, seller, amount, description, status, txid, role, mint, fee_collector) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
          role,
          mint || null,
          feeCollector
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
            role,
            mint: mint || null,
            fee_collector: feeCollector
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

// === FEE PAYER TRANSACTION ENDPOINTS ===

// Helper function to create and send transaction with fee_payer as feePayer
async function createAndSendTransaction(instruction, signers = []) {
  try {
    const connection = new solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
    
    // Create transaction with fee_payer as feePayer
    const transaction = new solanaWeb3.Transaction().add(instruction);
    transaction.feePayer = feePayerKeypair.publicKey;
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    
    // Sign with fee_payer and other signers
    const allSigners = [feePayerKeypair, ...signers];
    transaction.sign(...allSigners);
    
    // Send and confirm transaction
    const txid = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(txid, 'confirmed');
    
    return { success: true, txid };
  } catch (error) {
    console.error('Transaction error:', error);
    throw error;
  }
}

// Helper function to prepare transaction for user signing (fee_payer already signed)
async function prepareTransactionForSigning(instructions, requiredSigners) {
  try {
    const connection = new solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
    
    // Create transaction with fee_payer as feePayer
    const transaction = new solanaWeb3.Transaction();
    
    // Add instructions - support both single instruction and array of instructions
    if (Array.isArray(instructions)) {
      instructions.forEach(ix => transaction.add(ix));
    } else {
      transaction.add(instructions);
    }
    
    transaction.feePayer = feePayerKeypair.publicKey;
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    
    // Partially sign with fee_payer (this covers the feePayer signature)
    transaction.partialSign(feePayerKeypair);
    
    return {
      transaction: transaction.serialize({ requireAllSignatures: false }),
      requiredSigners,
      blockhash
    };
  } catch (error) {
    console.error('Prepare transaction error:', error);
    throw error;
  }
}

// Complete transaction after user signing
app.post('/transactions/complete', async (req, res) => {
  try {
    const { signedTransaction } = req.body;
    
    if (!signedTransaction) {
      return res.status(400).json({ error: 'signedTransaction is required' });
    }
    
    const connection = new solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
    
    // Deserialize the signed transaction
    const transaction = solanaWeb3.Transaction.from(Buffer.from(signedTransaction, 'base64'));
    
    // Send and confirm
    const txid = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(txid, 'confirmed');
    
    res.json({ success: true, txid });
  } catch (error) {
    console.error('Complete transaction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === JOIN OFFER WITH FEE PAYER ===

// Prepare join_offer transaction with fee_payer as feePayer
app.post('/contracts/prepare_join', async (req, res) => {
  try {
    const { escrowAddress, joinerPubkey, role } = req.body;
    
    if (!escrowAddress || !joinerPubkey || role === undefined) {
      return res.status(400).json({ error: 'escrowAddress, joinerPubkey, and role are required' });
    }
    
    // Get contract from database
    const contract = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM contracts WHERE address = ?', [escrowAddress], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    
    // Create join_offer instruction data manually
    const instructionData = Buffer.alloc(1 + 1 + 32); // 34 bytes
    instructionData[0] = 1; // join_offer instruction
    instructionData[1] = parseInt(role); // 0 = buyer joins, 1 = seller joins
    Buffer.from(new solanaWeb3.PublicKey(joinerPubkey).toBytes()).copy(instructionData, 2);
    
    const instruction = new solanaWeb3.TransactionInstruction({
      programId: new solanaWeb3.PublicKey(contract.programId),
      keys: [
        { pubkey: new solanaWeb3.PublicKey(joinerPubkey), isSigner: true, isWritable: true },
        { pubkey: new solanaWeb3.PublicKey(escrowAddress), isSigner: false, isWritable: true },
      ],
      data: instructionData
    });
    
    // Prepare transaction with fee_payer
    const result = await prepareTransactionForSigning(instruction, [joinerPubkey]);
    
    res.json({
      transaction: result.transaction.toString('base64'),
      requiredSigners: result.requiredSigners,
      blockhash: result.blockhash,
      escrowAddress,
      role
    });
    
  } catch (error) {
    console.error('Prepare join error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete join_offer transaction and update database
app.post('/contracts/complete_join', async (req, res) => {
  try {
    const { txid, escrowAddress, joinerPubkey, role } = req.body;
    
    if (!txid || !escrowAddress || !joinerPubkey || role === undefined) {
      return res.status(400).json({ error: 'txid, escrowAddress, joinerPubkey, and role are required' });
    }
    
    // Update contract in database
    await new Promise((resolve, reject) => {
      const sql = role === '0' 
        ? 'UPDATE contracts SET buyer = ?, status = ? WHERE address = ?'
        : 'UPDATE contracts SET seller = ?, status = ? WHERE address = ?';
      
      db.run(sql, [joinerPubkey, 'initialized', escrowAddress], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ 
      success: true, 
      txid,
      message: `${role === '0' ? 'Buyer' : 'Seller'} joined successfully. Fee paid by service.`
    });
    
  } catch (error) {
    console.error('Complete join error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === FUND ESCROW WITH FEE PAYER ===

// Prepare fund_escrow transaction with fee_payer as feePayer
app.post('/contracts/prepare_fund', async (req, res) => {
  try {
    const { escrowAddress, buyerPubkey } = req.body;
    
    if (!escrowAddress || !buyerPubkey) {
      return res.status(400).json({ error: 'escrowAddress and buyerPubkey are required' });
    }
    
    // Get contract from database
    const contract = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM contracts WHERE address = ?', [escrowAddress], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    
    // TEMPORARY FIX: Update contract mint if it's null but we know it should be SOL
    if (!contract.mint) {
      console.log('Contract mint is null, updating to SOL mint in database...');
      await new Promise((resolve, reject) => {
        db.run('UPDATE contracts SET mint = ? WHERE address = ?', ['So11111111111111111111111111111111111111112', escrowAddress], function(err) {
          if (err) {
            console.error('Failed to update contract mint:', err);
            reject(err);
          } else {
            console.log('Updated contract mint to SOL mint');
            contract.mint = 'So11111111111111111111111111111111111111112';
            resolve();
          }
        });
      });
    }
    
    if (contract.buyer !== buyerPubkey) {
      return res.status(403).json({ error: 'Only the buyer can fund the escrow' });
    }
    
    // Create fund_escrow instruction data
    const instructionData = Buffer.from([2]); // fund_escrow instruction
    
    // Инициализируем массив preInstructions для SPL токенов
    let preInstructions = [];
    
    // Determine if it's SOL or SPL token
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const isSOL = !contract.mint || contract.mint === SOL_MINT;
    
    // Use the correct SOL mint
    const SOL_MINT_PUBKEY = 'So11111111111111111111111111111111111111112'; 
    
    const keys = [
      { pubkey: new solanaWeb3.PublicKey(buyerPubkey), isSigner: true, isWritable: true }, // buyer
      { pubkey: new solanaWeb3.PublicKey(escrowAddress), isSigner: false, isWritable: true }, // escrow
      { pubkey: new solanaWeb3.PublicKey(contract.vault), isSigner: false, isWritable: true }, // vault
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false }, // system program
    ];
    
    // For fund_escrow, only add mint account for SOL (it's optional in the contract)
    if (isSOL) {
      keys.push({ pubkey: new solanaWeb3.PublicKey(SOL_MINT_PUBKEY), isSigner: false, isWritable: false }); // mint (optional)
    } else {
      // For SPL tokens, add all required accounts with proper ATA addresses
      
      // Вычисляем правильные ATA адреса
      const buyerTokenAccount = await getAssociatedTokenAddress(
        new solanaWeb3.PublicKey(contract.mint),
        new solanaWeb3.PublicKey(buyerPubkey)
      );
      
      const vaultTokenAccount = await getAssociatedTokenAddress(
        new solanaWeb3.PublicKey(contract.mint),
        new solanaWeb3.PublicKey(contract.vault),
        true // allowOwnerOffCurve for PDA
      );
      
      console.log('SPL Token accounts:');
      console.log('- Buyer ATA:', buyerTokenAccount.toString());
      console.log('- Vault ATA:', vaultTokenAccount.toString());
      
      // Проверяем существование ATA аккаунтов и добавляем инструкции создания если нужно
      const connection = new solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
      
      // Проверяем buyer ATA
      try {
        await getAccount(connection, buyerTokenAccount);
        console.log('- Buyer ATA exists');
      } catch (error) {
        console.log('- Creating buyer ATA instruction (paid by fee_payer)');
        preInstructions.push(
          createAssociatedTokenAccountInstruction(
            feePayerKeypair.publicKey, // payer (fee_payer covers ATA creation)
            buyerTokenAccount, // ata
            new solanaWeb3.PublicKey(buyerPubkey), // owner
            new solanaWeb3.PublicKey(contract.mint) // mint
          )
        );
      }
      
      // Проверяем vault ATA
      try {
        await getAccount(connection, vaultTokenAccount);
        console.log('- Vault ATA exists');
      } catch (error) {
        console.log('- Creating vault ATA instruction (paid by fee_payer)');
        preInstructions.push(
          createAssociatedTokenAccountInstruction(
            feePayerKeypair.publicKey, // payer (fee_payer covers ATA creation)
            vaultTokenAccount, // ata
            new solanaWeb3.PublicKey(contract.vault), // owner (vault PDA)
            new solanaWeb3.PublicKey(contract.mint) // mint
          )
        );
      }
      
      keys.push(
        { pubkey: new solanaWeb3.PublicKey(contract.mint), isSigner: false, isWritable: false }, // mint
        { pubkey: buyerTokenAccount, isSigner: false, isWritable: true }, // buyer_token_account (ATA)
        { pubkey: vaultTokenAccount, isSigner: false, isWritable: true }, // vault_token_account (ATA)
        { pubkey: new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false } // token program
      );
    }
    
    console.log('Fund escrow instruction details:');
    console.log('- Contract:', {
      mint: contract.mint,
      isSOL: isSOL,
      vault: contract.vault,
      buyer: contract.buyer,
      seller: contract.seller,
      status: contract.status,
      amount: contract.amount,
      address: escrowAddress
    });
    // Verify vault PDA
    const [expectedVaultPDA, vaultBump] = await solanaWeb3.PublicKey.findProgramAddress(
      [Buffer.from('vault'), new solanaWeb3.PublicKey(escrowAddress).toBuffer()],
      new solanaWeb3.PublicKey(contract.programId)
    );
    
    console.log('- Vault PDA check:');
    console.log('  Expected vault PDA:', expectedVaultPDA.toString());
    console.log('  Actual vault from DB:', contract.vault);
    console.log('  Vault PDA matches:', expectedVaultPDA.toString() === contract.vault);
    console.log('  Vault bump:', vaultBump);
    
    // Check buyer balance
    const connection = new solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
    const buyerBalance = await connection.getBalance(new solanaWeb3.PublicKey(buyerPubkey));
    console.log('- Buyer balance check:');
    console.log('  Buyer balance:', buyerBalance / 1e9, 'SOL');
    console.log('  Required amount:', contract.amount / 1e9, 'SOL');
    console.log('  Has sufficient balance:', buyerBalance >= contract.amount);
    
    // Check escrow account state on blockchain
    try {
      const escrowAccount = await connection.getAccountInfo(new solanaWeb3.PublicKey(escrowAddress));
      console.log('- Escrow account on-chain check:');
      console.log('  Account exists:', !!escrowAccount);
      console.log('  Account data length:', escrowAccount?.data?.length || 0);
      console.log('  Account owner:', escrowAccount?.owner?.toString());
      
      if (escrowAccount && escrowAccount.data.length >= 170) {
        // Try to decode escrow account data
        const data = escrowAccount.data;
        const buyer = new solanaWeb3.PublicKey(data.slice(0, 32)).toString();
        const seller = new solanaWeb3.PublicKey(data.slice(32, 64)).toString();
        const arbiter = new solanaWeb3.PublicKey(data.slice(64, 96)).toString();
        const amount = data.readBigUInt64LE(96);
        const state = data[104];
        const vaultBump = data[105];
        const mint = new solanaWeb3.PublicKey(data.slice(106, 138)).toString();
        const feeCollector = new solanaWeb3.PublicKey(data.slice(138, 170)).toString();
        
        console.log('  On-chain escrow data:');
        console.log('    Buyer:', buyer);
        console.log('    Seller:', seller);
        console.log('    State:', state, state === 2 ? '(Initialized)' : '(Other)');
        console.log('    Amount:', Number(amount));
        console.log('    Mint:', mint);
        console.log('    Fee collector:', feeCollector);
      }
    } catch (error) {
      console.log('- Escrow account check failed:', error.message);
    }
    
    console.log('- Keys count:', keys.length);
    console.log('- Keys:', keys.map(k => ({ 
      pubkey: k.pubkey.toString(), 
      isSigner: k.isSigner, 
      isWritable: k.isWritable 
    })));
    
    const instruction = new solanaWeb3.TransactionInstruction({
      programId: new solanaWeb3.PublicKey(contract.programId),
      keys,
      data: instructionData
    });
    
    // Combine preInstructions (ATA creation) with main instruction
    const allInstructions = [...preInstructions, instruction];
    console.log('- Total instructions:', allInstructions.length);
    console.log('- Pre-instructions (ATA creation):', preInstructions.length);
    
    // Prepare transaction with fee_payer
    const result = await prepareTransactionForSigning(allInstructions, [buyerPubkey]);
    
    res.json({
      transaction: result.transaction.toString('base64'),
      requiredSigners: result.requiredSigners,
      blockhash: result.blockhash,
      escrowAddress,
      amount: contract.amount
    });
    
  } catch (error) {
    console.error('Prepare fund error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete fund_escrow transaction and update database
app.post('/contracts/complete_fund', async (req, res) => {
  try {
    const { txid, escrowAddress, buyerPubkey } = req.body;
    
    if (!txid || !escrowAddress || !buyerPubkey) {
      return res.status(400).json({ error: 'txid, escrowAddress, and buyerPubkey are required' });
    }
    
    // Update contract status in database
    await new Promise((resolve, reject) => {
      db.run('UPDATE contracts SET status = ? WHERE address = ?', ['funded', escrowAddress], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ 
      success: true, 
      txid,
      message: 'Escrow funded successfully. Gas paid by service.'
    });
    
  } catch (error) {
    console.error('Complete fund error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Seller confirm endpoint - prepares transaction with fee_payer
app.post('/contracts/prepare_seller_confirm', async (req, res) => {
  try {
    const { escrowAddress, sellerPubkey } = req.body;
    
    if (!escrowAddress || !sellerPubkey) {
      return res.status(400).json({ error: 'escrowAddress and sellerPubkey are required' });
    }
    
    // Get contract from database
    const contract = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM contracts WHERE address = ?', [escrowAddress], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    
    if (contract.seller !== sellerPubkey) {
      return res.status(403).json({ error: 'Only the seller can confirm fulfillment' });
    }
    
    if (contract.status !== 'funded') {
      return res.status(400).json({ error: 'Contract must be in funded state' });
    }
    
    // Create seller_confirm instruction data
    const instructionData = Buffer.from([9]); // seller_confirm instruction
    
    const keys = [
      { pubkey: new solanaWeb3.PublicKey(sellerPubkey), isSigner: true, isWritable: true }, // seller
      { pubkey: new solanaWeb3.PublicKey(escrowAddress), isSigner: false, isWritable: true }, // escrow
    ];
    
    const instruction = new solanaWeb3.TransactionInstruction({
      programId: new solanaWeb3.PublicKey(contract.programId),
      keys,
      data: instructionData
    });
    
    // Prepare transaction with fee_payer
    const result = await prepareTransactionForSigning(instruction, [sellerPubkey]);
    
    res.json({
      success: true,
      transaction: result.transaction,
      message: 'Seller confirm transaction prepared. Fee_payer will cover gas costs.'
    });
    
  } catch (error) {
    console.error('Prepare seller confirm error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete seller confirm endpoint
app.post('/contracts/complete_seller_confirm', async (req, res) => {
  try {
    const { txid, escrowAddress, sellerPubkey } = req.body;
    
    if (!txid || !escrowAddress || !sellerPubkey) {
      return res.status(400).json({ error: 'txid, escrowAddress and sellerPubkey are required' });
    }
    
    // Update contract status to seller_confirmed
    await new Promise((resolve, reject) => {
      db.run('UPDATE contracts SET status = ?, txid = ? WHERE address = ?', 
        ['seller_confirmed', txid, escrowAddress], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ 
      success: true, 
      txid,
      message: 'Seller confirmed fulfillment successfully. Gas paid by service.'
    });
    
  } catch (error) {
    console.error('Complete seller confirm error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Buyer confirm (final confirm) endpoint - prepares transaction with fee_payer
app.post('/contracts/prepare_buyer_confirm', async (req, res) => {
  try {
    const { escrowAddress, buyerPubkey } = req.body;
    
    if (!escrowAddress || !buyerPubkey) {
      return res.status(400).json({ error: 'escrowAddress and buyerPubkey are required' });
    }
    
    // Get contract from database
    const contract = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM contracts WHERE address = ?', [escrowAddress], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    
    if (contract.buyer !== buyerPubkey) {
      return res.status(403).json({ error: 'Only the buyer can confirm the escrow' });
    }
    
    if (contract.status !== 'seller_confirmed') {
      return res.status(400).json({ error: 'Contract must be in seller_confirmed state' });
    }
    
    // Create confirm_escrow instruction data  
    const instructionData = Buffer.from([3]); // confirm_escrow instruction
    
    // Determine if it's SOL or SPL token
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const isSOL = !contract.mint || contract.mint === SOL_MINT;
    
    // Initialize preInstructions for SPL token ATA creation
    let preInstructions = [];
    
    const keys = [
      { pubkey: new solanaWeb3.PublicKey(buyerPubkey), isSigner: true, isWritable: true }, // buyer
      { pubkey: new solanaWeb3.PublicKey(escrowAddress), isSigner: false, isWritable: true }, // escrow
      { pubkey: new solanaWeb3.PublicKey(contract.vault), isSigner: false, isWritable: true }, // vault
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false }, // system program
      { pubkey: new solanaWeb3.PublicKey(contract.seller), isSigner: false, isWritable: true }, // seller_account
    ];
    
    // Add SPL token accounts if needed
    if (!isSOL) {
      // Вычисляем правильные ATA адреса для SPL токенов
      const vaultTokenAccount = await getAssociatedTokenAddress(
        new solanaWeb3.PublicKey(contract.mint),
        new solanaWeb3.PublicKey(contract.vault),
        true // allowOwnerOffCurve for PDA
      );
      
      const sellerTokenAccount = await getAssociatedTokenAddress(
        new solanaWeb3.PublicKey(contract.mint),
        new solanaWeb3.PublicKey(contract.seller)
      );
      
      // Check if seller ATA exists and create instruction if needed
      const connection = new solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
      try {
        await getAccount(connection, sellerTokenAccount);
        console.log('- Seller ATA exists');
      } catch (error) {
        console.log('- Creating seller ATA instruction (paid by fee_payer)');
        preInstructions.push(
          createAssociatedTokenAccountInstruction(
            feePayerKeypair.publicKey, // payer (fee_payer covers ATA creation)
            sellerTokenAccount, // ata
            new solanaWeb3.PublicKey(contract.seller), // owner
            new solanaWeb3.PublicKey(contract.mint) // mint
          )
        );
      }
      
      keys.push(
        { pubkey: new solanaWeb3.PublicKey(contract.mint), isSigner: false, isWritable: false }, // mint
        { pubkey: vaultTokenAccount, isSigner: false, isWritable: true }, // vault_token_account (ATA)
        { pubkey: sellerTokenAccount, isSigner: false, isWritable: true }, // seller_token_account (ATA) 
        { pubkey: new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false } // token program
      );
    }
    
    const instruction = new solanaWeb3.TransactionInstruction({
      programId: new solanaWeb3.PublicKey(contract.programId),
      keys,
      data: instructionData
    });
    
    // Combine preInstructions (ATA creation) with main instruction
    const allInstructions = [...preInstructions, instruction];
    console.log('- Buyer confirm total instructions:', allInstructions.length);
    console.log('- Pre-instructions (ATA creation):', preInstructions.length);
    
    // Prepare transaction with fee_payer
    const result = await prepareTransactionForSigning(allInstructions, [buyerPubkey]);
    
    res.json({
      success: true,
      transaction: result.transaction,
      message: 'Buyer confirm transaction prepared. Fee_payer will cover gas costs.'
    });
    
  } catch (error) {
    console.error('Prepare buyer confirm error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete buyer confirm endpoint
app.post('/contracts/complete_buyer_confirm', async (req, res) => {
  try {
    const { txid, escrowAddress, buyerPubkey } = req.body;
    
    if (!txid || !escrowAddress || !buyerPubkey) {
      return res.status(400).json({ error: 'txid, escrowAddress and buyerPubkey are required' });
    }
    
    // Update contract status to completed
    await new Promise((resolve, reject) => {
      db.run('UPDATE contracts SET status = ?, txid = ? WHERE address = ?', 
        ['completed', txid, escrowAddress], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    
    res.json({ 
      success: true, 
      txid,
      message: 'Escrow confirmed by buyer. Funds released to seller. Gas paid by service.'
    });
    
  } catch (error) {
    console.error('Complete buyer confirm error:', error);
    res.status(500).json({ error: error.message });
  }
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

// Эндпоинт для создания транзакции создания ордера (возвращает неподписанную транзакцию)
app.post('/contracts/prepare_create', async (req, res) => {
  console.log('PREPARE CREATE CONTRACT:', req.body);
  const { 
    initiatorPubkey,
    arbiter, 
    amount, 
    description, 
    role,
    mint,
    programId
  } = req.body;
  
  if (!initiatorPubkey || !arbiter || !amount || !role) {
    return res.status(400).json({ 
      error: 'initiatorPubkey, arbiter, amount, role required' 
    });
  }
  
  if (!isValidPubkey(initiatorPubkey)) {
    return res.status(400).json({ error: 'Invalid initiatorPubkey' });
  }
  if (!isValidPubkey(arbiter)) {
    return res.status(400).json({ error: 'Invalid arbiter pubkey' });
  }
  if (mint && !isValidPubkey(mint)) {
    return res.status(400).json({ error: 'Invalid mint pubkey' });
  }
  
  try {
    const initiatorPublicKey = new solanaWeb3.PublicKey(initiatorPubkey);
    const arbiterPubkey = new solanaWeb3.PublicKey(arbiter);
    const mintPubkey = mint ? new solanaWeb3.PublicKey(mint) : 
                            new solanaWeb3.PublicKey('So11111111111111111111111111111111111111112'); // native SOL
    const programPubkey = new solanaWeb3.PublicKey(programId || 'HAnbSMXSSBDysfSDWviYMwTD4h2vzRkp4Xd9rSP76kwe');
    
    // Генерируем случайный seed для анонимности (32 байта)
    const randomSeed = solanaWeb3.Keypair.generate().publicKey.toBuffer(); // 32 random bytes
    
    // Генерируем PDA для escrow и vault с random seed
    const [escrowPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), randomSeed],
      programPubkey
    );
    
    const [vaultPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), escrowPDA.toBuffer()],
      programPubkey
    );
    
    // Создаем instruction data в новом формате с random seed
    const instructionData = Buffer.alloc(1 + 1 + 8 + 32 + 32 + 32 + 32); // 138 bytes total
    instructionData[0] = 0; // create_offer instruction
    instructionData[1] = parseInt(role); // 0 = buyer creates, 1 = seller creates
    instructionData.writeBigUInt64LE(BigInt(amount), 2); // amount
    Buffer.from(arbiterPubkey.toBytes()).copy(instructionData, 10); // arbiter pubkey
    Buffer.from(mintPubkey.toBytes()).copy(instructionData, 42); // mint pubkey
    Buffer.from(feePayerKeypair.publicKey.toBytes()).copy(instructionData, 74); // fee_collector pubkey
    randomSeed.copy(instructionData, 106); // random seed for anonymity
    
    res.json({
      success: true,
      escrowPDA: escrowPDA.toString(),
      vaultPDA: vaultPDA.toString(),
      randomSeed: randomSeed.toString('hex'), // для сохранения в БД
      instructionData: Array.from(instructionData),
      accounts: {
        initiator: initiatorPubkey,
        escrowAccount: escrowPDA.toString(),
        vault: vaultPDA.toString(),
        systemProgram: solanaWeb3.SystemProgram.programId.toString(),
        mint: mintPubkey.toString(),
        feeCollector: feePayerKeypair.publicKey.toString(),
      },
      programId: programPubkey.toString(),
      feeCollector: feePayerKeypair.publicKey.toString(),
      serviceFeeLamports: 10000000 // 0.01 SOL
    });
    
  } catch (error) {
    console.error('Prepare create contract error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Эндпоинт для сохранения успешно созданного контракта
app.post('/contracts/save_created', async (req, res) => {
  const { 
    escrowPDA, 
    vaultPDA,
    randomSeed,
    arbiter, 
    buyer,
    seller,
    amount, 
    description, 
    txid,
    role,
    mint,
    programId
  } = req.body;
  
  if (!escrowPDA || !vaultPDA || !arbiter || !amount || !txid || !role) {
    return res.status(400).json({ 
      error: 'escrowPDA, vaultPDA, arbiter, amount, txid, role required' 
    });
  }
  
  try {
    db.run(
      'INSERT INTO contracts (address, vault, programId, arbiter, buyer, seller, amount, description, status, txid, role, mint, fee_collector, random_seed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        escrowPDA,
        vaultPDA,
        programId || 'HAnbSMXSSBDysfSDWviYMwTD4h2vzRkp4Xd9rSP76kwe',
        arbiter,
        buyer,
        seller,
        amount,
        description || '',
        'created',
        txid,
        role,
        mint || null,
        feePayerKeypair.publicKey.toString(),
        randomSeed
      ],
      function (err) {
        if (err) {
          console.error('DB error:', err);
          return res.status(500).json({ error: err.message });
        }
        
        res.json({
          id: this.lastID,
          address: escrowPDA,
          vault: vaultPDA,
          arbiter,
          buyer: buyer || null,
          seller: seller || null,
          amount,
          description: description || '',
          status: 'created',
          txid,
          role,
          mint: mint || null,
          fee_collector: feePayerKeypair.publicKey.toString()
        });
      }
    );
  } catch (error) {
    console.error('Save created contract error:', error);
    res.status(500).json({ error: error.message });
  }
});

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