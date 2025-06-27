import React, { useMemo, useState } from 'react';
import { ConnectionProvider, WalletProvider, useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
    SolflareWalletAdapter,
    TorusWalletAdapter,
    LedgerWalletAdapter,
    NightlyWalletAdapter,
    WalletConnectWalletAdapter
} from '@solana/wallet-adapter-wallets';
import { clusterApiUrl, Transaction, TransactionInstruction, PublicKey, Keypair, SystemProgram, Connection } from '@solana/web3.js';
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
    createDefaultWalletNotFoundHandler
} from '@solana-mobile/wallet-adapter-mobile';

// === HARDCODED CONFIG ===
const API_URL = 'http://localhost:3000';
const PROGRAM_ID = new PublicKey('9tUopKjowt1d8aDcdgGcVN7zPeMTstbwyqNKNqnba6vh');
const ARBITER = new PublicKey('DVPU9yF5G6TzH8LtfrACYrdAjWmgr8gd7u1xaWSu4sTQ');
const CONNECTION_URL = 'https://api.devnet.solana.com';

// Helper to check if a string is valid base58 (for Solana addresses)
function isValidBase58(str) {
    try {
        return !!str && bs58.decode(str);
    } catch {
        return false;
    }
}

function App() {
    // Wallet adapter setup for Solana devnet
    const network = 'devnet';
    const endpoint = useMemo(() => clusterApiUrl(network), [network]);
    const wallets = useMemo(() => [
        new SolanaMobileWalletAdapter({
            addressSelector: createDefaultAddressSelector(),
            appIdentity: { name: "Solana Escrow Mini App" },
            authorizationResultCache: createDefaultAuthorizationResultCache(),
            chain: 'solana:devnet',
            onWalletNotFound: createDefaultWalletNotFoundHandler()
        }),
        new SolflareWalletAdapter(),
        new TorusWalletAdapter(),
        new LedgerWalletAdapter(),
        new NightlyWalletAdapter(),
        new WalletConnectWalletAdapter({
            network: 'devnet',
            options: {
                relayUrl: 'wss://relay.walletconnect.com',
                projectId: '38295d3d88057287538e78184720b5fb'
            }
        })
    ], []);

    return (
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <MainAppContent />
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}

function MainAppContent() {
    const { publicKey, signTransaction } = useWallet();
    const { connection } = useConnection();
    const walletAddress = publicKey ? publicKey.toBase58() : null;
    const [refresh, setRefresh] = React.useState(0);
    const [manageContract, setManageContract] = React.useState(null);
    const [actionsOpen, setActionsOpen] = React.useState(false);
    const [showApply, setShowApply] = useState(false);
    const ESCROW_ACCOUNT_SIZE = 106;

    // Create a new escrow order (on-chain + backend)
    const handleCreateOrder = async ({ amount, description, role }) => {
        if (!publicKey || !signTransaction) throw new Error('Wallet not connected');
        try {
            const connection = new Connection(CONNECTION_URL, 'confirmed');
            const escrowAccount = Keypair.generate();
            const [vault, vaultBump] = await PublicKey.findProgramAddress(
                [Buffer.from('vault'), escrowAccount.publicKey.toBuffer()],
                PROGRAM_ID
            );

            // 1. Create escrow account on-chain
            const createEscrowIx = SystemProgram.createAccount({
                fromPubkey: publicKey,
                newAccountPubkey: escrowAccount.publicKey,
                lamports: await connection.getMinimumBalanceForRentExemption(ESCROW_ACCOUNT_SIZE),
                space: ESCROW_ACCOUNT_SIZE,
                programId: PROGRAM_ID
            });

            // 2. Prepare create_offer instruction
            const instructionData = Buffer.alloc(1 + 1 + 8 + 32);
            instructionData[0] = 0; // create_offer
            instructionData[1] = role === 'buyer' ? 0 : 1; // 0 = buyer creates, 1 = seller creates
            instructionData.writeBigUInt64LE(BigInt(Number(amount)), 2);
            ARBITER.toBuffer().copy(instructionData, 10);

            const createOfferIx = new TransactionInstruction({
                keys: [
                    { pubkey: publicKey, isSigner: true, isWritable: true }, // initiator
                    { pubkey: escrowAccount.publicKey, isSigner: true, isWritable: true },
                    { pubkey: vault, isSigner: false, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
                ],
                programId: PROGRAM_ID,
                data: instructionData
            });

            // 3. Build and sign transaction
            const tx = new Transaction().add(createEscrowIx, createOfferIx);
            tx.feePayer = publicKey;
            tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
            tx.partialSign(escrowAccount); // escrow account must sign

            // 4. Sign and send transaction via wallet
            const signed = await signTransaction(tx);
            const txid = await connection.sendRawTransaction(signed.serialize());
            await connection.confirmTransaction(txid, 'confirmed');

            // 5. Save contract metadata to backend
            const res = await fetch(`${API_URL}/contracts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    escrowAccount: escrowAccount.publicKey.toBase58(),
                    vault: vault.toBase58(),
                    arbiter: ARBITER.toBase58(),
                    buyer: role === 'buyer' ? publicKey.toBase58() : null,
                    seller: role === 'seller' ? publicKey.toBase58() : null,
                    amount: Number(amount),
                    description,
                    txid,
                    role,
                    programId: PROGRAM_ID.toBase58()
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Order creation error');
            }
            setRefresh(r => r + 1);
        } catch (error) {
            console.error('Error creating contract:', error);
            if (error.logs) {
                alert((error.message || 'Order creation error') + '\n\nLogs:\n' + error.logs.join('\n'));
            } else {
                alert(error.message);
            }
        }
    };

    // Join an existing escrow order (on-chain + backend)
    const handleApplyOrder = async (escrowAddress) => {
        if (!publicKey || !signTransaction) throw new Error('Wallet not connected');
        if (!isValidBase58(escrowAddress)) throw new Error('Invalid contract address');
        try {
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
            Buffer.from(new PublicKey(publicKey).toBytes()).copy(data, 2);
            const instruction = new TransactionInstruction({
                programId: PROGRAM_ID,
                keys: [
                    { pubkey: publicKey, isSigner: true, isWritable: true }, // joiner
                    { pubkey: new PublicKey(escrowAddress), isSigner: false, isWritable: true }
                ],
                data
            });
            // 4. Build and sign transaction
            const tx = new Transaction().add(instruction);
            tx.feePayer = publicKey;
            tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
            const signedTx = await signTransaction(tx);
            // 5. Send transaction
            const sig = await connection.sendRawTransaction(signedTx.serialize());
            await connection.confirmTransaction(sig, 'confirmed');
            // 6. Update backend with join info
            const body = {
                joiner: publicKey.toBase58(),
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
        } catch (error) {
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
    const handleRemoveContract = async (address) => {
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
    const handleManageContract = (contract) => {
        setManageContract(contract);
        setActionsOpen(true);
    };

    // Handle all contract actions (fund, confirm, buyer_confirm, arbiter_confirm, etc.)
    const handleAction = async (action) => {
        if (!manageContract || !publicKey || !signTransaction) return;
        const contract = manageContract;
        const { address, vault, programId, arbiter, buyer, seller } = contract;
        try {
            let instruction, tx, sig, body;
            switch (action) {
                case 'fund': {
                    // Buyer funds the escrow (state: initialized -> funded)
                    const data = Buffer.from([2]);
                    instruction = new TransactionInstruction({
                        programId: new PublicKey(programId),
                        keys: [
                            { pubkey: publicKey, isSigner: true, isWritable: true }, // buyer
                            { pubkey: new PublicKey(address), isSigner: false, isWritable: true },
                            { pubkey: new PublicKey(vault), isSigner: false, isWritable: true },
                            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
                        ],
                        data
                    });
                    tx = new Transaction().add(instruction);
                    break;
                }
                case 'confirm': {
                    // Seller confirms fulfillment (state: funded -> seller_confirmed)
                    const data = Buffer.from([9]);
                    instruction = new TransactionInstruction({
                        programId: new PublicKey(programId),
                        keys: [
                            { pubkey: publicKey, isSigner: true, isWritable: true }, // seller
                            { pubkey: new PublicKey(address), isSigner: false, isWritable: true }
                        ],
                        data
                    });
                    tx = new Transaction().add(instruction);
                    break;
                }
                case 'arbiter_confirm': {
                    // Arbiter confirms escrow, funds go to seller
                    const data = Buffer.from([4]);
                    instruction = new TransactionInstruction({
                        programId: new PublicKey(programId),
                        keys: [
                            { pubkey: publicKey, isSigner: true, isWritable: true }, // arbiter
                            { pubkey: new PublicKey(address), isSigner: false, isWritable: true },
                            { pubkey: new PublicKey(vault), isSigner: false, isWritable: true },
                            { pubkey: new PublicKey(seller), isSigner: false, isWritable: true }
                        ],
                        data
                    });
                    tx = new Transaction().add(instruction);
                    break;
                }
                case 'arbiter_cancel': {
                    // Arbiter cancels escrow, funds return to buyer
                    const data = Buffer.from([5]);
                    instruction = new TransactionInstruction({
                        programId: new PublicKey(programId),
                        keys: [
                            { pubkey: publicKey, isSigner: true, isWritable: true }, // arbiter
                            { pubkey: new PublicKey(address), isSigner: false, isWritable: true },
                            { pubkey: new PublicKey(vault), isSigner: false, isWritable: true },
                            { pubkey: new PublicKey(buyer), isSigner: false, isWritable: true }
                        ],
                        data
                    });
                    tx = new Transaction().add(instruction);
                    break;
                }
                case 'mutual_cancel': {
                    // Buyer and seller mutually cancel escrow
                    const data = Buffer.from([8]);
                    instruction = new TransactionInstruction({
                        programId: new PublicKey(programId),
                        keys: [
                            { pubkey: new PublicKey(buyer), isSigner: true, isWritable: true },
                            { pubkey: new PublicKey(seller), isSigner: true, isWritable: true },
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
                            { pubkey: publicKey, isSigner: true, isWritable: true }, // closer
                            { pubkey: new PublicKey(address), isSigner: false, isWritable: true }
                        ],
                        data
                    });
                    tx = new Transaction().add(instruction);
                    break;
                }
                case 'buyer_confirm': {
                    // Buyer confirms escrow, funds go to seller (state: seller_confirmed -> completed)
                    const data = Buffer.from([3]);
                    instruction = new TransactionInstruction({
                        programId: new PublicKey(programId),
                        keys: [
                            { pubkey: publicKey, isSigner: true, isWritable: true }, // buyer
                            { pubkey: new PublicKey(address), isSigner: false, isWritable: true }, // escrowAccount
                            { pubkey: new PublicKey(vault), isSigner: false, isWritable: true }, // vault
                            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
                            { pubkey: new PublicKey(seller), isSigner: false, isWritable: true } // seller_account
                        ],
                        data
                    });
                    tx = new Transaction().add(instruction);
                    break;
                }
                default:
                    throw new Error('Unknown action');
            }
            tx.feePayer = publicKey;
            tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
            const signedTx = await signTransaction(tx);
            sig = await connection.sendRawTransaction(signedTx.serialize());
            await connection.confirmTransaction(sig, 'confirmed');
            body = {
                contract: address,
                action,
                txid: sig,
                actor: publicKey.toBase58()
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
        } catch (e) {
            if (e.logs) {
                alert((e.message || 'Action error') + '\n\nLogs:\n' + e.logs.join('\n'));
            } else {
                alert(e.message || 'Action error');
            }
        }
    };

    return (
        <div style={{ maxWidth: 520, margin: '0 auto', padding: 24, background: 'linear-gradient(135deg, #191a2e 0%, #2b2d4a 100%)', minHeight: '100vh', color: '#fff', fontFamily: 'Inter, Arial, sans-serif' }}>
            <h2 style={{ color: '#14f195', letterSpacing: 1, fontWeight: 700, marginBottom: 16 }}>Solana Escrow Mini App</h2>
            <WalletMultiButton style={{ background: '#9945ff', color: '#fff', borderRadius: 8, marginBottom: 12 }} />
            <button
                onClick={() => {
                    localStorage.removeItem('walletName');
                    localStorage.removeItem('walletAdapter');
                    localStorage.removeItem('selectedWallet');
                    localStorage.removeItem('wallet');
                    localStorage.removeItem('walletconnect');
                    localStorage.removeItem('nightly:wallets');
                    window.location.reload();
                }}
                style={{ width: '100%', background: '#23244a', color: '#fff', border: 'none', borderRadius: 8, padding: 10, fontWeight: 500, fontSize: 15, marginBottom: 24, cursor: 'pointer' }}
            >
                Reset wallet selection
            </button>
            {walletAddress && (
                <>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                        <button onClick={() => setShowApply(false)} style={{ flex: 1, background: !showApply ? '#14f195' : '#23244a', color: !showApply ? '#191a2e' : '#fff', border: 'none', borderRadius: 8, padding: 12, fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'all 0.2s' }}>Create order</button>
                        <button onClick={() => setShowApply(true)} style={{ flex: 1, background: showApply ? '#14f195' : '#23244a', color: showApply ? '#191a2e' : '#fff', border: 'none', borderRadius: 8, padding: 12, fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'all 0.2s' }}>Join order</button>
                    </div>
                    {!showApply && <CreateOrder onCreate={handleCreateOrder} />}
                    {showApply && <ApplyOrder onApply={handleApplyOrder} onBack={() => setShowApply(false)} />}
                    <ContractsList
                        walletAddress={walletAddress}
                        key={refresh}
                        onRemove={handleRemoveContract}
                        onManage={handleManageContract}
                    />
                    <ContractActions
                        contract={manageContract}
                        open={actionsOpen}
                        onClose={() => setActionsOpen(false)}
                        onAction={handleAction}
                        arbiterAddress={ARBITER.toBase58()}
                    />
                </>
            )}
        </div>
    );
}

export default App;