const solanaWeb3 = require('@solana/web3.js');

/**
 * Create an escrow offer on Solana blockchain.
 * @param {Object} params - Parameters for the offer.
 * @returns {Promise<string>} Transaction signature.
 */
async function createOffer({
  connectionUrl,
  programId,
  buyerKeypair,
  escrowAccountPubkey,
  vaultPubkey,
  arbiterPubkey,
  amount
}) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');

  // Инструкция: [0, amount(8 bytes), arbiter(32 bytes)]
  const instructionData = Buffer.alloc(1 + 8 + 32);
  instructionData[0] = 0; // create_offer
  instructionData.writeBigUInt64LE(BigInt(amount), 1);
  Buffer.from(arbiterPubkey.toBytes()).copy(instructionData, 9);

  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: buyerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultPubkey, isSigner: false, isWritable: true },
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData
  });

  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(
    connection,
    tx,
    [buyerKeypair]
  );
  return signature;
}

// --- join_offer ---
async function joinOffer({ connectionUrl, programId, sellerKeypair, escrowAccountPubkey }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  const instructionData = Buffer.alloc(1 + 32);
  instructionData[0] = 1; // join_offer
  Buffer.from(sellerKeypair.publicKey.toBytes()).copy(instructionData, 1);
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: sellerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
    ],
    data: instructionData
  });
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [sellerKeypair]);
  return signature;
}

// --- fund_escrow ---
async function fundEscrow({ connectionUrl, programId, buyerKeypair, escrowAccountPubkey, vaultPubkey }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  const instructionData = Buffer.from([2]); // fund_escrow
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: buyerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultPubkey, isSigner: false, isWritable: true },
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData
  });
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [buyerKeypair]);
  return signature;
}

// --- confirm_escrow ---
async function confirmEscrow({ connectionUrl, programId, sellerKeypair, escrowAccountPubkey, vaultPubkey }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  const instructionData = Buffer.from([3]); // confirm_escrow
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: sellerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultPubkey, isSigner: false, isWritable: true },
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData
  });
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [sellerKeypair]);
  return signature;
}

// --- arbiter_confirm ---
async function arbiterConfirm({ connectionUrl, programId, arbiterKeypair, escrowAccountPubkey, vaultPubkey, sellerPubkey }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  const instructionData = Buffer.from([4]); // arbiter_confirm
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: arbiterKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultPubkey, isSigner: false, isWritable: true },
      { pubkey: sellerPubkey, isSigner: false, isWritable: true },
    ],
    data: instructionData
  });
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [arbiterKeypair]);
  return signature;
}

// --- arbiter_cancel ---
async function arbiterCancel({ connectionUrl, programId, arbiterKeypair, escrowAccountPubkey, vaultPubkey, buyerPubkey }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  const instructionData = Buffer.from([5]); // arbiter_cancel
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: arbiterKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultPubkey, isSigner: false, isWritable: true },
      { pubkey: buyerPubkey, isSigner: false, isWritable: true },
    ],
    data: instructionData
  });
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [arbiterKeypair]);
  return signature;
}

// --- mutual_cancel ---
async function mutualCancel({ connectionUrl, programId, buyerKeypair, sellerKeypair, escrowAccountPubkey, vaultPubkey }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  const instructionData = Buffer.from([8]); // mutual_cancel
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: buyerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: sellerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultPubkey, isSigner: false, isWritable: true },
    ],
    data: instructionData
  });
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [buyerKeypair, sellerKeypair]);
  return signature;
}

// --- close_escrow ---
async function closeEscrow({ connectionUrl, programId, closerKeypair, escrowAccountPubkey }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  const instructionData = Buffer.from([6]); // close_escrow
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: closerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
    ],
    data: instructionData
  });
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [closerKeypair]);
  return signature;
}

// --- get_escrow_info ---
async function getEscrowInfo({ connectionUrl, programId, escrowAccountPubkey }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  const instructionData = Buffer.from([7]); // get_escrow_info
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
    ],
    data: instructionData
  });
  // Для get_escrow_info обычно просто отправляют транзакцию и смотрят логи
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, []);
  return signature;
}

module.exports = {
  createOffer,
  joinOffer,
  fundEscrow,
  confirmEscrow,
  arbiterConfirm,
  arbiterCancel,
  mutualCancel,
  closeEscrow,
  getEscrowInfo
}; 