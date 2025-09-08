import React, { useMemo, useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider, useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton, WalletDisconnectButton } from '@solana/wallet-adapter-react-ui';
import {
  HuobiWalletAdapter,
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter,
  WalletConnectWalletAdapter
} from '@solana/wallet-adapter-wallets';
import { clusterApiUrl, Transaction, TransactionInstruction, PublicKey, Keypair, SystemProgram, Connection } from '@solana/web3.js';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import '@solana/wallet-adapter-react-ui/styles.css';
import ContractsList from './components/ContractsList';
import CreateOrder from './components/CreateOrder';
import ApplyOrder from './components/ApplyOrder';
import bs58 from 'bs58';
import ContractActions from './components/ContractActions';
import './App.css';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import {
    SolanaMobileWalletAdapter,
    createDefaultAddressSelector,
    createDefaultAuthorizationResultCache,
} from '@solana-mobile/wallet-adapter-mobile';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAccount } from '@solana/spl-token';
import { registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler } from '@solana-mobile/wallet-standard-mobile';
// Register Mobile Wallet Adapter for mobile browser support (MWA will inject itself if available)
if (typeof window !== 'undefined') {
  registerMwa({
    appIdentity: {
      uri: window.location.origin,
      name: 'Solana Escrow Mini App',
    },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: ['solana:devnet'],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  });
}

// === HARDCODED CONFIG ===
const API_URL = 'http://localhost:3000'; // Update with your actual API URL
const PROGRAM_ID = new PublicKey('7aduXLXPVvUXX9hDWrKDyeJF1ij7hQxYnah4EzcSFmmE');
const ARBITER = new PublicKey('DVPU9yF5G6TzH8LtfrACYrdAjWmgr8gd7u1xaWSu4sTQ');
const CONNECTION_URL = 'https://api.devnet.solana.com';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Fee collector will be fetched from API
let FEE_COLLECTOR: PublicKey | null = null;

// Добавлено: Проверка мобильного устройства
const isMobile = () => {
  return typeof window !== 'undefined' && 
         /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
};

interface CreateOrderParams {
    amount: string;
    description: string;
    role: 'buyer' | 'seller';
    mint: string;
}
interface Contract {
    address: string;
    vault: string;
    programId: string;
    arbiter: string;
    buyer: string;
    seller: string;
    amount: number;
    description: string;
    status?: string;
    [key: string]: any;
}

function isValidBase58(str: string): boolean {
    try {
        return !!str && !!bs58.decode(str);
    } catch {
        return false;
    }
}

const getAppOrigin = () => {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return 'https://escrow.netlify.app/';
};

function getWallets(network: WalletAdapterNetwork) {
  // Only add desktop wallets; MWA will be injected automatically on mobile
  return [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
  ];
}

function AppWrapper() {
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);
  const wallets = useMemo(() => getWallets(network), [network]);
  const mobile = isMobile();

  return (
    <>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect={!mobile}>
          <WalletModalProvider>
            <div className="escrow-app-container">
              <App />
            </div>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </>
  );
}


function App() {
  const { publicKey, disconnect, connected, wallet } = useWallet();
  const walletAddress = publicKey?.toBase58() || '';
  const [isMobileDevice, setIsMobileDevice] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [refresh, setRefresh] = useState<number>(0);
  const [manageContract, setManageContract] = useState<Contract | null>(null);
  const [actionsOpen, setActionsOpen] = useState<boolean>(false);
  const ESCROW_ACCOUNT_SIZE = 170; // Обновлённый размер с fee_collector (+32 байта)
  const getPublicKey = (address: string) => new PublicKey(address);

  useEffect(() => {
    setIsMobileDevice(isMobile());
  }, []);

  // Обработчик для кнопки подключения
  const handleConnectClick = () => {
    if (isMobileDevice) {
      setConnecting(true);
      
      // Добавляем небольшую задержку для обработки навигации
      setTimeout(() => {
        setConnecting(false);
      }, 3000);
    }
  };

  // Create a new escrow order with automatic fee collection
  const handleCreateOrder = async ({ amount, description, role, mint }: CreateOrderParams): Promise<void> => {
      if (!walletAddress || !wallet?.adapter) throw new Error('Wallet not connected');
      
      try {
          const connection = new Connection(CONNECTION_URL, 'confirmed');
          const userPubkey = getPublicKey(walletAddress);
          
          // 1. Получаем подготовленную транзакцию с API
          const prepareRes = await fetch(`${API_URL}/contracts/prepare_create`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  initiatorPubkey: walletAddress,
                  arbiter: ARBITER.toBase58(),
                  amount: Number(amount),
                  description,
                  role: role === 'buyer' ? '0' : '1',
                  mint: mint === SOL_MINT ? null : mint,
                  programId: PROGRAM_ID.toBase58(),
              })
          });
          
          if (!prepareRes.ok) {
              const err = await prepareRes.json();
              throw new Error(err.error || 'Failed to prepare transaction');
          }
          
          const prepareData = await prepareRes.json();
          const { escrowPDA, vaultPDA, randomSeed, instructionData, accounts, programId, serviceFeeLamports } = prepareData;
          
          // 2. Создаем create_offer инструкцию с fee_collector (аккаунты создадутся автоматически)
          const createOfferIx = new TransactionInstruction({
              keys: [
                  { pubkey: userPubkey, isSigner: true, isWritable: true },
                  { pubkey: new PublicKey(escrowPDA), isSigner: false, isWritable: true },
                  { pubkey: new PublicKey(vaultPDA), isSigner: false, isWritable: true },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                  { pubkey: new PublicKey(accounts.mint), isSigner: false, isWritable: false },
                  { pubkey: new PublicKey(accounts.feeCollector), isSigner: false, isWritable: true },
              ],
              programId: new PublicKey(programId),
              data: Buffer.from(instructionData)
          });
          
          // 3. Собираем транзакцию
          const tx = new Transaction().add(createOfferIx);
          tx.feePayer = userPubkey;
          const { blockhash } = await connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          
          // 4. Отправляем через кошелек
          console.log('Transaction details:', {
              feePayer: tx.feePayer?.toBase58(),
              recentBlockhash: tx.recentBlockhash,
              instructions: tx.instructions.length,
              accounts: tx.instructions[0].keys.map(k => ({
                  pubkey: k.pubkey.toBase58(),
                  isSigner: k.isSigner,
                  isWritable: k.isWritable
              }))
          });
          
          // Сначала симулируем транзакцию для получения детальной информации об ошибках
          console.log('Simulating transaction...');
          try {
              const simulation = await connection.simulateTransaction(tx);
              console.log('Simulation result:', simulation);
              
              if (simulation.value.err) {
                  console.error('Simulation failed:', simulation.value.err);
                  throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
              }
          } catch (simError: any) {
              console.error('Simulation error:', simError);
              throw new Error(`Failed to simulate transaction: ${simError.message}`);
          }
          
          let txid: string;
          try {
              txid = await wallet.adapter.sendTransaction(tx, connection, {
                  skipPreflight: true, // Пропускаем preflight т.к. уже симулировали
                  preflightCommitment: 'confirmed'
              });
              console.log('Transaction sent:', txid);
              
              await connection.confirmTransaction(txid, 'confirmed');
              console.log('Transaction confirmed');
          } catch (sendError: any) {
              console.error('Send transaction error:', sendError);
              throw sendError;
          }
          
          // 5. Сохраняем в базе данных
          const saveRes = await fetch(`${API_URL}/contracts/save_created`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  escrowPDA,
                  vaultPDA,
                  randomSeed,
                  arbiter: ARBITER.toBase58(),
                  buyer: role === 'buyer' ? userPubkey.toBase58() : null,
                  seller: role === 'seller' ? userPubkey.toBase58() : null,
                  amount: Number(amount),
                  description,
                  txid,
                  role: role === 'buyer' ? '0' : '1',
                  mint: mint === SOL_MINT ? null : mint,
                  programId: PROGRAM_ID.toBase58(),
              })
          });
          
          if (!saveRes.ok) {
              const err = await saveRes.json();
              console.warn('Failed to save to database:', err);
              // Не прерываем выполнение, т.к. транзакция уже прошла
          }
          
          setRefresh(r => r + 1);
          toast.success(
              `Order created! Service fee: ${serviceFeeLamports / 1e9} SOL collected.\nTx: ${txid.slice(0, 8)}...`
          );
          
      } catch (error: any) {
          console.error('Error creating contract:', error);
          toast.error(error.message || 'Order creation error');
      }
  };
  // Join an existing escrow order (on-chain + backend)
  const handleApplyOrder = async (escrowAddress: string): Promise<void> => {
      if (!walletAddress || !wallet?.adapter) throw new Error('Wallet not connected');
      if (!isValidBase58(escrowAddress)) throw new Error('Invalid contract address');
      
      try {
          const userPubkey = getPublicKey(walletAddress);
          
          // 1. Fetch contract info from backend
          const contractRes = await fetch(`${API_URL}/contracts/by_address/${escrowAddress}`);
          if (!contractRes.ok) {
              throw new Error('Contract not found');
          }
          const contract = await contractRes.json();
          
          // 2. Determine joiner role based on who created and what's available
          let joinerRole;
          console.log('Contract data:', contract);
          
          if (contract.buyer && contract.seller) {
              throw new Error('Contract is already full - both buyer and seller are set');
          }
          
          // If creator was buyer, join as seller
          if (contract.buyer && !contract.seller) {
              joinerRole = 'seller';
          }
          // If creator was seller, join as buyer  
          else if (contract.seller && !contract.buyer) {
              joinerRole = 'buyer';
          }
          // Fallback to old logic if role field is available
          else if (contract.role === 'seller' || contract.role === '1') {
              joinerRole = 'buyer'; // If seller created, join as buyer
          } else {
              joinerRole = 'seller'; // If buyer created, join as seller
          }
          
          console.log('Determined joiner role:', joinerRole);
          
          // 3. Prepare transaction with fee_payer through backend
          const prepareRes = await fetch(`${API_URL}/contracts/prepare_join`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  escrowAddress,
                  joinerPubkey: userPubkey.toBase58(),
                  role: joinerRole === 'buyer' ? '0' : '1'
              })
          });
          
          if (!prepareRes.ok) {
              const err = await prepareRes.json();
              throw new Error(err.error || 'Failed to prepare transaction');
          }
          
          const prepareData = await prepareRes.json();
          
          // 4. Create transaction from prepared data and send through wallet
          // The backend has already prepared the transaction with fee_payer as feePayer
          const transaction = Transaction.from(Buffer.from(prepareData.transaction, 'base64'));
          const connection = new Connection(CONNECTION_URL, 'confirmed');
          
          console.log('Transaction details:', {
              feePayer: transaction.feePayer?.toBase58(),
              recentBlockhash: transaction.recentBlockhash,
              instructions: transaction.instructions.length,
              signatures: transaction.signatures.length,
              accounts: transaction.instructions[0]?.keys.map(k => ({
                  pubkey: k.pubkey.toBase58(),
                  isSigner: k.isSigner,
                  isWritable: k.isWritable
              }))
          });
          
          // Simulate transaction first
          console.log('Simulating transaction...');
          try {
              const simulation = await connection.simulateTransaction(transaction);
              console.log('Simulation result:', simulation);
              
              if (simulation.value.err) {
                  console.error('Simulation failed:', simulation.value.err);
                  throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
              }
          } catch (simError: any) {
              console.error('Simulation error:', simError);
              throw new Error(`Failed to simulate transaction: ${simError.message}`);
          }
          
          // Send transaction - wallet will sign and fee_payer will pay gas
          const txid = await wallet.adapter.sendTransaction(transaction, connection, {
              skipPreflight: true, // Skip since we already simulated
              preflightCommitment: 'confirmed'
          });
          
          await connection.confirmTransaction(txid, 'confirmed');
          console.log('Transaction confirmed:', txid);
          
          // 5. Update database through backend
          const completeRes = await fetch(`${API_URL}/contracts/complete_join`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  txid,
                  escrowAddress,
                  joinerPubkey: userPubkey.toBase58(),
                  role: joinerRole === 'buyer' ? '0' : '1'
              })
          });
          
          if (!completeRes.ok) {
              const err = await completeRes.json();
              console.warn('Failed to update database:', err);
              // Don't throw error since transaction already succeeded
          }
          
          const result = { txid };
          
          toast.success(`Successfully joined as ${joinerRole}! Gas paid by service. Tx: ${result.txid.slice(0, 8)}...`);
          setRefresh(r => r + 1);
          
      } catch (error: any) {
          console.error('Apply order error:', error);
          toast.error(error.message || 'Failed to join order');
      }
  };

  // Remove contract from backend (only allowed in certain states)
  const handleRemoveContract = async (address: string): Promise<void> => {
      const res = await fetch(`${API_URL}/contracts/${address}`, {
          method: 'DELETE'
      });
      if (!res.ok) {
          const err = await res.json();
          alert(err.error || 'Contract removal error');
      }
      setRefresh(r => r + 1);
  };

  // Open contract management modal
  const handleManageContract = (contract: Contract): void => {
      setManageContract(contract);
      setActionsOpen(true);
  };

  // Handle all contract actions (fund, confirm, buyer_confirm, arbiter_confirm, etc.)
  const handleAction = async (action: string): Promise<void> => {
      if (!manageContract || !walletAddress || !wallet?.adapter) return;
      const contract = manageContract;
      const { address, vault, programId, arbiter, buyer, seller } = contract;
      try {
          let instruction: TransactionInstruction, tx: Transaction, sig: string, body: any;
          switch (action) {
              case 'fund': {
                  // Buyer funds the escrow with fee_payer gas payment
                  const userPubkey = getPublicKey(walletAddress);
                  
                  // 1. Prepare transaction through backend
                  const prepareRes = await fetch(`${API_URL}/contracts/prepare_fund`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          escrowAddress: address,
                          buyerPubkey: userPubkey.toBase58()
                      })
                  });
                  
                  if (!prepareRes.ok) {
                      const err = await prepareRes.json();
                      throw new Error(err.error || 'Failed to prepare fund transaction');
                  }
                  
                  const prepareData = await prepareRes.json();
                  
                  // 2. Create transaction and send through wallet (fee_payer pays gas)
                  const transaction = Transaction.from(Buffer.from(prepareData.transaction, 'base64'));
                  const connection = new Connection(CONNECTION_URL, 'confirmed');
                  
                  // Simulate first
                  try {
                      const simulation = await connection.simulateTransaction(transaction);
                      if (simulation.value.err) {
                          throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
                      }
                  } catch (simError: any) {
                      throw new Error(`Failed to simulate transaction: ${simError.message}`);
                  }
                  
                  // Send transaction
                  const txid = await wallet.adapter.sendTransaction(transaction, connection, {
                      skipPreflight: true,
                      preflightCommitment: 'confirmed'
                  });
                  
                  await connection.confirmTransaction(txid, 'confirmed');
                  
                  // 3. Update database
                  const completeRes = await fetch(`${API_URL}/contracts/complete_fund`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          txid,
                          escrowAddress: address,
                          buyerPubkey: userPubkey.toBase58()
                      })
                  });
                  
                  if (!completeRes.ok) {
                      const err = await completeRes.json();
                      console.warn('Failed to update database:', err);
                  }
                  
                  toast.success(`Escrow funded successfully! Gas paid by service. Tx: ${txid.slice(0, 8)}...`);
                  setRefresh(r => r + 1);
                  setActionsOpen(false);
                  return; // Exit early since we handled everything
              }
              case 'confirm': {
                  // Seller confirms fulfillment with fee_payer gas payment
                  const userPubkey = getPublicKey(walletAddress);
                  
                  // 1. Prepare transaction through backend
                  const prepareRes = await fetch(`${API_URL}/contracts/prepare_seller_confirm`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          escrowAddress: address,
                          sellerPubkey: userPubkey.toBase58()
                      })
                  });
                  
                  if (!prepareRes.ok) {
                      const err = await prepareRes.json();
                      throw new Error(err.error || 'Failed to prepare seller confirm transaction');
                  }
                  
                  const prepareData = await prepareRes.json();
                  
                  // 2. Create transaction and send through wallet (fee_payer pays gas)
                  const transaction = Transaction.from(Buffer.from(prepareData.transaction, 'base64'));
                  const connection = new Connection(CONNECTION_URL, 'confirmed');
                  
                  // Send transaction
                  const txid = await wallet.adapter.sendTransaction(transaction, connection, {
                      skipPreflight: true,
                      preflightCommitment: 'confirmed'
                  });
                  
                  await connection.confirmTransaction(txid, 'confirmed');
                  
                  // 3. Update database
                  const completeRes = await fetch(`${API_URL}/contracts/complete_seller_confirm`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          txid,
                          escrowAddress: address,
                          sellerPubkey: userPubkey.toBase58()
                      })
                  });
                  
                  if (!completeRes.ok) {
                      const err = await completeRes.json();
                      console.warn('Failed to update database:', err);
                  }
                  
                  toast.success(`Seller confirmed fulfillment! Gas paid by service. Tx: ${txid.slice(0, 8)}...`);
                  setRefresh(r => r + 1);
                  setActionsOpen(false);
                  return; // Exit early since we handled everything
              }
              case 'arbiter_confirm': {
                  // Arbiter confirms escrow, funds go to seller
                  const mintStr = contract.mint;
                  if (!mintStr) throw new Error('Mint is undefined');
                  let mint: PublicKey;
                  try {
                      mint = new PublicKey(mintStr);
                  } catch (e) {
                      throw new Error('Mint is not a valid public key: ' + mintStr);
                  }
                  const isSol = mint.toBase58() === SOL_MINT;
                  const keys = [
                      { pubkey: getPublicKey(walletAddress), isSigner: true, isWritable: true }, 
                      { pubkey: new PublicKey(address), isSigner: false, isWritable: true },
                      { pubkey: new PublicKey(vault), isSigner: false, isWritable: true },
                      { pubkey: new PublicKey(seller), isSigner: false, isWritable: true }
                  ];
                  const instructions = [];
                  if (!isSol) {
                      const connection = new Connection(CONNECTION_URL, 'confirmed');
                      const vaultTokenAccount = await getAssociatedTokenAddress(mint, new PublicKey(vault), true);
                      const sellerTokenAccount = await getAssociatedTokenAddress(mint, new PublicKey(seller));
                      try {
                          await getAccount(connection, vaultTokenAccount);
                      } catch {
                          instructions.push(
                              createAssociatedTokenAccountInstruction(
                                  getPublicKey(walletAddress), 
                                  vaultTokenAccount,
                                  new PublicKey(vault),
                                  mint
                              )
                          );
                      }
                      try {
                          await getAccount(connection, sellerTokenAccount);
                      } catch {
                          instructions.push(
                              createAssociatedTokenAccountInstruction(
                                  getPublicKey(walletAddress), 
                                  sellerTokenAccount,
                                  new PublicKey(seller),
                                  mint
                              )
                          );
                      }
                      keys.push(
                          { pubkey: mint, isSigner: false, isWritable: false },
                          { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
                          { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },
                          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
                      );
                  }
                  const data = Buffer.from([4]);
                  instruction = new TransactionInstruction({
                      programId: new PublicKey(programId),
                      keys,
                      data
                  });
                  tx = new Transaction();
                  if (instructions.length > 0) {
                      for (const ix of instructions) tx.add(ix);
                  }
                  tx.add(instruction);
                  break;
              }
              case 'arbiter_cancel': {
                  // Arbiter cancels escrow, funds return to buyer
                  const mintStr = contract.mint;
                  if (!mintStr) throw new Error('Mint is undefined');
                  let mint: PublicKey;
                  try {
                      mint = new PublicKey(mintStr);
                  } catch (e) {
                      throw new Error('Mint is not a valid public key: ' + mintStr);
                  }
                  const isSol = mint.toBase58() === SOL_MINT;
                  const keys = [
                      { pubkey: getPublicKey(walletAddress), isSigner: true, isWritable: true }, // arbiter
                      { pubkey: new PublicKey(address), isSigner: false, isWritable: true },
                      { pubkey: new PublicKey(vault), isSigner: false, isWritable: true },
                      { pubkey: new PublicKey(buyer), isSigner: false, isWritable: true }
                  ];
                  const instructions = [];
                  if (!isSol) {
                      const connection = new Connection(CONNECTION_URL, 'confirmed');
                      const vaultTokenAccount = await getAssociatedTokenAddress(mint, new PublicKey(vault), true);
                      const buyerTokenAccount = await getAssociatedTokenAddress(mint, new PublicKey(buyer));
                      try {
                          await getAccount(connection, vaultTokenAccount);
                      } catch {
                          instructions.push(
                              createAssociatedTokenAccountInstruction(
                                  getPublicKey(walletAddress), 
                                  vaultTokenAccount,
                                  new PublicKey(vault),
                                  mint
                              )
                          );
                      }
                      // Проверяем, существует ли buyer ATA
                      try {
                          await getAccount(connection, buyerTokenAccount);
                      } catch {
                          instructions.push(
                              createAssociatedTokenAccountInstruction(
                                  getPublicKey(walletAddress), 
                                  buyerTokenAccount,
                                  new PublicKey(buyer),
                                  mint
                              )
                          );
                      }
                      keys.push(
                          { pubkey: mint, isSigner: false, isWritable: false },
                          { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
                          { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
                          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
                      );
                  }
                  const data = Buffer.from([5]);
                  instruction = new TransactionInstruction({
                      programId: new PublicKey(programId),
                      keys,
                      data
                  });
                  tx = new Transaction();
                  if (instructions.length > 0) {
                      for (const ix of instructions) tx.add(ix);
                  }
                  tx.add(instruction);
                  break;
              }
              case 'mutual_cancel': {
                  // Buyer and seller mutually cancel escrow
                  const data = Buffer.from([8]);
                  instruction = new TransactionInstruction({
                      programId: new PublicKey(programId),
                      keys: [
                          { pubkey: getPublicKey(buyer), isSigner: true, isWritable: true },
                          { pubkey: getPublicKey(seller), isSigner: true, isWritable: true },
                          { pubkey: new PublicKey(address), isSigner: false, isWritable: true },
                          { pubkey: new PublicKey(vault), isSigner: false, isWritable: true }
                      ],
                      data
                  });
                  tx = new Transaction().add(instruction);
                  break;
              }
              case 'close': {
                  // Close escrow account (after completion or cancellation)
                  const data = Buffer.from([6]);
                  instruction = new TransactionInstruction({
                      programId: new PublicKey(programId),
                      keys: [
                          { pubkey: getPublicKey(walletAddress), isSigner: true, isWritable: true }, // closer
                          { pubkey: new PublicKey(address), isSigner: false, isWritable: true }
                      ],
                      data
                  });
                  tx = new Transaction().add(instruction);
                  break;
              }
              case 'buyer_confirm': {
                  // Buyer confirms escrow with fee_payer gas payment
                  const userPubkey = getPublicKey(walletAddress);
                  
                  // 1. Prepare transaction through backend
                  const prepareRes = await fetch(`${API_URL}/contracts/prepare_buyer_confirm`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          escrowAddress: address,
                          buyerPubkey: userPubkey.toBase58()
                      })
                  });
                  
                  if (!prepareRes.ok) {
                      const err = await prepareRes.json();
                      throw new Error(err.error || 'Failed to prepare buyer confirm transaction');
                  }
                  
                  const prepareData = await prepareRes.json();
                  
                  // 2. Create transaction and send through wallet (fee_payer pays gas)
                  const transaction = Transaction.from(Buffer.from(prepareData.transaction, 'base64'));
                  const connection = new Connection(CONNECTION_URL, 'confirmed');
                  
                  // Send transaction
                  const txid = await wallet.adapter.sendTransaction(transaction, connection, {
                      skipPreflight: true,
                      preflightCommitment: 'confirmed'
                  });
                  
                  await connection.confirmTransaction(txid, 'confirmed');
                  
                  // 3. Update database
                  const completeRes = await fetch(`${API_URL}/contracts/complete_buyer_confirm`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          txid,
                          escrowAddress: address,
                          buyerPubkey: userPubkey.toBase58()
                      })
                  });
                  
                  if (!completeRes.ok) {
                      const err = await completeRes.json();
                      console.warn('Failed to update database:', err);
                  }
                  
                  toast.success(`Escrow confirmed! Funds released to seller. Gas paid by service. Tx: ${txid.slice(0, 8)}...`);
                  setRefresh(r => r + 1);
                  setActionsOpen(false);
                  return; // Exit early since we handled everything
              }
              default:
                  throw new Error('Unknown action');
          }
          tx.feePayer = getPublicKey(walletAddress);
          tx.recentBlockhash = (await new Connection(CONNECTION_URL, 'confirmed').getRecentBlockhash()).blockhash;
      
          // Always use wallet.adapter.sendTransaction for both desktop and mobile
          sig = await wallet.adapter.sendTransaction(tx, new Connection(CONNECTION_URL, 'confirmed'));
          await new Connection(CONNECTION_URL, 'confirmed').confirmTransaction(sig, 'confirmed');
          body = {
              contract: address,
              action,
              txid: sig,
              actor: getPublicKey(walletAddress).toBase58()
          };
          // Map action to status for backend update
          let status = null;
          if (action === 'confirm') status = 'seller_confirmed';
          else if (action === 'buyer_confirm') status = 'completed';
          else if (action === 'arbiter_confirm') status = 'completed';
          else if (action === 'arbiter_cancel') status = 'cancelled';
          else if (action === 'mutual_cancel') status = 'cancelled';
          else if (action === 'close') status = 'closed';
          if (status) {
              await fetch(`${API_URL}/contracts/${address}/status`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status, txid: sig })
              });
          }
          setActionsOpen(false);
          setManageContract(null);
          setRefresh(r => r + 1);
      } catch (e: any) {
          if (e.logs) {
              alert((e.message || 'Action error') + '\n\nLogs:\n' + e.logs.join('\n'));
          } else {
              alert(e.message || 'Action error');
          }
      }
  };

  return (
    <div>
      <div className="escrow-title">Solana Escrow Mini App</div>
      <div className="wallet-bar">
        {/* Show connect button or wallet address */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
          {!connected ? (
            <WalletMultiButton 
              style={{ 
                background: '#9945ff', 
                color: '#fff', 
                border: 'none', 
                borderRadius: 8, 
                padding: '14px 16px', 
                fontWeight: 700, 
                fontSize: 16, 
                cursor: 'pointer',
                width: '100%'
              }}
              onClick={handleConnectClick}
            >
              {connecting ? 'Connecting...' : 'Connect Wallet'}
            </WalletMultiButton>
          ) : (
            <div style={{ width: '100%' }}>
              <button
                style={{
                  background: '#23244a',
                  color: '#14f195',
                  border: 'none',
                  borderRadius: 8,
                  padding: '14px 16px',
                  fontWeight: 700,
                  fontSize: 16,
                  width: '100%',
                  cursor: 'pointer',
                  letterSpacing: 1
                }}
                title={walletAddress}
                disabled
              >
                {walletAddress.slice(0, 4) + '...' + walletAddress.slice(-4)}
              </button>
              <div style={{ marginTop: 8 }}>
                <WalletDisconnectButton style={{ width: '100%' }} />
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="escrow-topbar">
        <button onClick={() => setShowApply(false)} className={`escrow-btn${!showApply ? ' active' : ''}`}>Create order</button>
        <button onClick={() => setShowApply(true)} className={`escrow-btn${showApply ? ' active' : ''}`}>Join order</button>
      </div>
      {!showApply && <CreateOrder onCreate={handleCreateOrder} />}
      {showApply && <ApplyOrder onApply={handleApplyOrder} onBack={() => setShowApply(false)} />}
      <div className="escrow-list">
        <ContractsList
          walletAddress={walletAddress}
          key={refresh}
          onRemove={handleRemoveContract}
          onManage={handleManageContract}
        />
      </div>
      <ContractActions
        contract={manageContract}
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
        onAction={handleAction}
        arbiterAddress={ARBITER.toBase58()}
        walletAddress={walletAddress}
      />
      <ToastContainer position="bottom-right" theme="dark" />
    </div>
  );
}

export default AppWrapper;
