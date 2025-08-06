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
const API_URL = 'https://55c14c3635b6.ngrok-free.app';
const PROGRAM_ID = new PublicKey('7WBqX2Lo4g4BxhTwKqGijJAqBWtnSukH96SaFhJsiehg');
const ARBITER = new PublicKey('DVPU9yF5G6TzH8LtfrACYrdAjWmgr8gd7u1xaWSu4sTQ');
const CONNECTION_URL = 'https://api.devnet.solana.com';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

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
  const ESCROW_ACCOUNT_SIZE = 138;
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

  // Create a new escrow order (on-chain + backend)
  const handleCreateOrder = async ({ amount, description, role, mint }: CreateOrderParams): Promise<void> => {
      if (!walletAddress || !wallet?.adapter) throw new Error('Wallet not connected');
      try {
          const connection = new Connection(CONNECTION_URL, 'confirmed');
          const userPubkey = getPublicKey(walletAddress);
          const escrowAccount = Keypair.generate();
          const [vault, vaultBump] = await PublicKey.findProgramAddress(
              [Buffer.from('vault'), escrowAccount.publicKey.toBuffer()],
              PROGRAM_ID
          );

          // 1. Create escrow account on-chain
          const createEscrowIx = SystemProgram.createAccount({
              fromPubkey: userPubkey,
              newAccountPubkey: escrowAccount.publicKey,
              lamports: await connection.getMinimumBalanceForRentExemption(ESCROW_ACCOUNT_SIZE),
              space: ESCROW_ACCOUNT_SIZE,
              programId: PROGRAM_ID
          });

          // 2. Prepare create_offer instruction
          const instructionData = Buffer.alloc(1 + 1 + 8 + 32 + 32);
          instructionData[0] = 0;
          instructionData[1] = role === 'buyer' ? 0 : 1;
          instructionData.writeBigUInt64LE(BigInt(Number(amount)), 2);
          ARBITER.toBuffer().copy(instructionData, 10);
          new PublicKey(mint).toBuffer().copy(instructionData, 42);

          const createOfferIx = new TransactionInstruction({
              keys: [
                  { pubkey: userPubkey, isSigner: true, isWritable: true },
                  { pubkey: escrowAccount.publicKey, isSigner: true, isWritable: true },
                  { pubkey: vault, isSigner: false, isWritable: true },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                  { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
              ],
              programId: PROGRAM_ID,
              data: instructionData
          });

          // 3. Build transaction
          const tx = new Transaction().add(createEscrowIx, createOfferIx);
          tx.feePayer = userPubkey;
          tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
          
          // 4. Подписываем транзакцию двумя подписями:
          //    - Подпись от escrow-аккаунта (локально)
          //    - Подпись от пользователя (через кошелек)
          tx.partialSign(escrowAccount);

          // Always use wallet.adapter.sendTransaction for both desktop and mobile
          const txid = await wallet.adapter.sendTransaction(tx, connection);
          await connection.confirmTransaction(txid, 'confirmed');

          // 5. Save contract metadata to backend
          const res = await fetch(`${API_URL}/contracts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  escrowAccount: escrowAccount.publicKey.toBase58(),
                  vault: vault.toBase58(),
                  arbiter: ARBITER.toBase58(),
                  buyer: role === 'buyer' ? userPubkey.toBase58() : null,
                  seller: role === 'seller' ? userPubkey.toBase58() : null,
                  amount: Number(amount),
                  description,
                  txid,
                  role,
                  programId: PROGRAM_ID.toBase58(),
                  mint,
              })
          });
          
          if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error || 'Order creation error');
          }
          setRefresh(r => r + 1);
          toast.success('Order created successfully!');
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
          const connection = new Connection(CONNECTION_URL, 'confirmed');
          const userPubkey = getPublicKey(walletAddress);
          // 1. Fetch contract info from backend
          const contractRes = await fetch(`${API_URL}/contracts/by_address/${escrowAddress}`);
          if (!contractRes.ok) {
              throw new Error('Contract not found');
          }
          const contract = await contractRes.json();
          // 2. Determine joiner role
          let joinerRole;
          if (contract.role === 'seller') {
              joinerRole = 'buyer'; // If seller created, join as buyer
          } else {
              joinerRole = 'seller'; // If buyer created, join as seller
          }
          // 3. Prepare join_offer instruction
          const data = Buffer.alloc(1 + 1 + 32);
          data[0] = 1; // join_offer
          data[1] = joinerRole === 'buyer' ? 0 : 1; // 0 = buyer joins, 1 = seller joins
          Buffer.from(userPubkey.toBytes()).copy(data, 2);
          const instruction = new TransactionInstruction({
              programId: PROGRAM_ID,
              keys: [
                  { pubkey: userPubkey, isSigner: true, isWritable: true }, // joiner
                  { pubkey: new PublicKey(escrowAddress), isSigner: false, isWritable: true }
              ],
              data
          });
          // 4. Build and sign transaction
          const tx = new Transaction().add(instruction);
          tx.feePayer = userPubkey;
          tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
          // Always use wallet.adapter.sendTransaction for both desktop and mobile
          const sig = await wallet.adapter.sendTransaction(tx, connection);
          await connection.confirmTransaction(sig, 'confirmed');
          // 6. Update backend with join info
          const body = {
              joiner: userPubkey.toBase58(),
              escrowAccount: escrowAddress,
              programId: PROGRAM_ID.toBase58(),
              txid: sig,
              role: contract.role
          };
          const res = await fetch(`${API_URL}/contracts/${escrowAddress}/join`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
          });
          if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error || 'Order join error');
          }
          setRefresh(r => r + 1);
      } catch (error: any) {
          console.error('Error join order:', error);
          if (error.logs) {
              alert((error.message || 'Order join error') + '\n\nLogs:\n' + error.logs.join('\n'));
          } else {
              alert(error.message || 'Order join error');
          }
          throw error;
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
                  // Buyer funds the escrow (state: initialized -> funded)
                  const mintStr = contract.mint;
                  if (!mintStr) throw new Error('Mint is undefined');
                  let mint: PublicKey;
                  try {
                      mint = new PublicKey(mintStr);
                  } catch (e) {
                      throw new Error('Mint is not a valid public key: ' + mintStr);
                  }
                  const isSol = mint.toBase58() === SOL_MINT;
                  if (!walletAddress) throw new Error('Wallet address is undefined');
                  if (!vault) throw new Error('Vault is undefined');
                  console.log('funding with mint:', mint.toBase58(), 'wallet:', walletAddress, 'vault:', vault);
                  const keys = [
                      { pubkey: getPublicKey(walletAddress), isSigner: true, isWritable: true }, // buyer
                      { pubkey: new PublicKey(address), isSigner: false, isWritable: true },
                      { pubkey: new PublicKey(vault), isSigner: false, isWritable: true },
                      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
                  ];
                  const instructions = [];
                  if (!isSol) {
                      const connection = new Connection(CONNECTION_URL, 'confirmed');
                      const buyerTokenAccount = await getAssociatedTokenAddress(mint, getPublicKey(walletAddress));
                      const vaultTokenAccount = await getAssociatedTokenAddress(mint, new PublicKey(vault), true);
                      try {
                          await getAccount(connection, buyerTokenAccount);
                      } catch {
                          instructions.push(
                              createAssociatedTokenAccountInstruction(
                                  getPublicKey(walletAddress), 
                                  buyerTokenAccount,
                                  getPublicKey(walletAddress),
                                  mint
                              )
                          );
                      }
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
                      keys.push(
                          { pubkey: mint, isSigner: false, isWritable: false },
                          { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
                          { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
                          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
                      );
                  }
                  const data = Buffer.from([2]);
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
              case 'confirm': {
                  // Seller confirms fulfillment (state: funded -> seller_confirmed)
                  const data = Buffer.from([9]);
                  instruction = new TransactionInstruction({
                      programId: new PublicKey(programId),
                      keys: [
                          { pubkey: getPublicKey(walletAddress), isSigner: true, isWritable: true }, // seller
                          { pubkey: new PublicKey(address), isSigner: false, isWritable: true }
                      ],
                      data
                  });
                  tx = new Transaction().add(instruction);
                  break;
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
                  // Buyer confirms escrow, funds go to seller (state: seller_confirmed -> completed)
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
                      { pubkey: getPublicKey(walletAddress), isSigner: true, isWritable: true }, // buyer
                      { pubkey: new PublicKey(address), isSigner: false, isWritable: true }, // escrowAccount
                      { pubkey: new PublicKey(vault), isSigner: false, isWritable: true }, // vault
                      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
                      { pubkey: new PublicKey(seller), isSigner: false, isWritable: true } // seller_account
                  ];
                  const instructions = [];
                  if (!isSol) {
                      const connection = new Connection(CONNECTION_URL, 'confirmed');
                      const vaultTokenAccount = await getAssociatedTokenAddress(mint, new PublicKey(vault), true);
                      const sellerTokenAccount = await getAssociatedTokenAddress(mint, new PublicKey(seller));
                      // Проверяем, существует ли vault ATA
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
                  const data = Buffer.from([3]);
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
          if (action === 'fund') status = 'funded';
          else if (action === 'confirm') status = 'seller_confirmed';
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
