import React, { useEffect, useState } from 'react';

const API_URL = 'https://55c14c3635b6.ngrok-free.app';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function shortAddr(addr: string): string {
    if (!addr) return '';
    return addr.slice(0, 4) + '...' + addr.slice(-4);
}

function shortMint(mint: string): string {
    if (!mint) return '';
    return mint.slice(0, 4) + '...' + mint.slice(-4);
}

export interface Contract {
    address: string;
    vault: string;
    programId: string;
    arbiter: string;
    buyer: string;
    seller: string;
    amount: number;
    description: string;
    status?: string;
    mint?: string; // Added mint field
    [key: string]: any;
}

interface ContractsListProps {
    walletAddress: string;
    onRemove: (address: string) => void;
    onManage: (contract: Contract) => void;
}

function ContractsList({ walletAddress, onRemove, onManage }: ContractsListProps) {
    const [contracts, setContracts] = useState<Contract[]>([]);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string>('');

    useEffect(() => {
        if (!walletAddress) return;
        setLoading(true);
        setError(null);
        
        fetch(`${API_URL}/contracts/user/${walletAddress}`, {
            method: "get",
            headers: new Headers({
                "ngrok-skip-browser-warning": "69420",
            }),
        })
            .then(res => {
                if (!res.ok) {
                    throw new Error(`HTTP error! status: ${res.status}`);
                }
                return res.json();
            })
            .then(data => {
                console.log('Contracts loaded:', data);
                setContracts(Array.isArray(data) ? data : []);
            })
            .catch(err => {
                console.error('Error loading contracts:', err);
                setError(err.message);
                setContracts([]);
            })
            .finally(() => setLoading(false));
    }, [walletAddress]);

    const handleCopy = (addr: string) => {
        navigator.clipboard.writeText(addr);
        setCopied(addr);
        setTimeout(() => setCopied(''), 1200);
    };

    if (!walletAddress) return <div>Connect your wallet to view contracts.</div>;
    if (loading) return <div>Loading contracts...</div>;
    if (error) return <div>Error loading: {error}</div>;
    if (!contracts.length) return <div>No contracts found.</div>;

    return (
        <div style={{ marginTop: 24 }}>
            <h3>Your contracts</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {contracts.map(contract => {
                    const isSeller = contract.seller === walletAddress;
                    const isBuyer = contract.buyer === walletAddress;
                    let userRole = isSeller ? 'Seller' : isBuyer ? 'Buyer' : '';
                    let badgeColor = contract.status === 'funded' ? '#14f195' : contract.status === 'seller_confirmed' ? '#9945ff' : '#23244a';
                    return (
                        <div key={contract.address || contract.id} className="card">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <span className="status-badge" style={{ background: badgeColor, color: badgeColor === '#14f195' ? '#191a2e' : '#fff' }}>{contract.status}</span>
                                <span className="role-badge">{userRole}</span>
                            </div>
                            <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 4 }} className="card-description">{contract.description}</div>
                            <div style={{ fontSize: 14, color: '#aaa', marginBottom: 4 }}>
                                Address: <span style={{ color: '#14f195', fontWeight: 500 }} className="card-address">{shortAddr(contract.address)}</span>
                                <button
                                    onClick={() => handleCopy(contract.address)}
                                    style={{
                                        marginLeft: 6,
                                        background: 'none',
                                        border: 'none',
                                        color: '#14f195',
                                        cursor: 'pointer',
                                        fontWeight: 700,
                                        padding: 0,
                                        width: 'auto',
                                        height: 'auto',
                                        lineHeight: 1,
                                        fontSize: 18,
                                        display: 'inline',
                                        verticalAlign: 'middle'
                                    }}
                                    title="Copy address"
                                >
                                    {copied === contract.address ? '✓' : '⧉'}
                                </button>
                            </div>
                            <div style={{ fontSize: 14, color: '#aaa', marginBottom: 4 }}>
                                Amount: <span style={{ color: '#14f195', fontWeight: 600 }}>{(contract.amount / 1_000_000_000).toLocaleString()} {contract.mint === SOL_MINT ? 'SOL' : 'SPL'}</span>
                            </div>
                            <div style={{ fontSize: 14, color: '#aaa', marginBottom: 4 }}>
                                Token: {contract.mint === SOL_MINT ? 'SOL' : 'SPL'}
                                {contract.mint && contract.mint !== SOL_MINT && (
                                    <span style={{ marginLeft: 8, color: '#fff' }}>Mint: {shortMint(contract.mint)}</span>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                <button style={{ flex: 1 }} onClick={() => onManage(contract)}>Manage</button>
                                <button style={{ flex: 1, background: '#ff3860', color: '#fff' }} onClick={() => onRemove(contract.address)}>Delete</button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default ContractsList; 