const solanaWeb3 = require('@solana/web3.js');

/**
 * Create an escrow offer on Solana blockchain.
 * @param {Object} params - Parameters for the offer.
 * @returns {Promise<string>} Transaction signature.
 */
async function createOffer({
  connectionUrl,
  programId,
  initiatorKeypair,
  escrowAccountPubkey,
  vaultPubkey,
  arbiterPubkey,
  amount,
  role,
  mint,
  feeCollectorPubkey
}) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');

  // Новый формат инструкции: [0, role(1), amount(8), arbiter(32), mint(32), fee_collector(32)]
  const instructionData = Buffer.alloc(1 + 1 + 8 + 32 + 32 + 32); // 106 bytes total
  instructionData[0] = 0; // create_offer instruction
  instructionData[1] = role; // 0 = buyer creates, 1 = seller creates
  instructionData.writeBigUInt64LE(BigInt(amount), 2); // amount
  Buffer.from(arbiterPubkey.toBytes()).copy(instructionData, 10); // arbiter pubkey
  Buffer.from(mint.toBytes()).copy(instructionData, 42); // mint pubkey
  Buffer.from(feeCollectorPubkey.toBytes()).copy(instructionData, 74); // fee_collector pubkey

  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: initiatorKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultPubkey, isSigner: false, isWritable: true },
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false }, // mint account
      { pubkey: feeCollectorPubkey, isSigner: false, isWritable: true }, // fee collector account
    ],
    data: instructionData
  });

  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(
    connection,
    tx,
    [initiatorKeypair]
  );
  return signature;
}

// --- join_offer ---
async function joinOffer({ connectionUrl, programId, joinerKeypair, escrowAccountPubkey, role }) {
  const connection = new solanaWeb3.Connection(connectionUrl, 'confirmed');
  
  // Новый формат: [1, role(1), joiner_pubkey(32)]
  const instructionData = Buffer.alloc(1 + 1 + 32); // 34 bytes
  instructionData[0] = 1; // join_offer instruction
  instructionData[1] = role; // 0 = buyer joins, 1 = seller joins
  Buffer.from(joinerKeypair.publicKey.toBytes()).copy(instructionData, 2);
  
  const instruction = new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(programId),
    keys: [
      { pubkey: joinerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: escrowAccountPubkey, isSigner: false, isWritable: true },
    ],
    data: instructionData
  });
  
  const tx = new solanaWeb3.Transaction().add(instruction);
  const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [joinerKeypair]);
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