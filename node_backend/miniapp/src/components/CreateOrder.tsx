import React, { useState } from 'react';

interface CreateOrderParams {
    amount: string; // в лампортах
    description: string;
    role: 'buyer' | 'seller';
    mint: string; // адрес mint
}
interface CreateOrderProps {
    onCreate: (params: CreateOrderParams) => Promise<void>;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function CreateOrder({ onCreate }: CreateOrderProps) {
    const [amount, setAmount] = useState<string>(''); // в SOL
    const [description, setDescription] = useState<string>('');
    const [role, setRole] = useState<'buyer' | 'seller'>('seller');
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string>('');
    const [mint, setMint] = useState<string>(SOL_MINT);
    const [showTokenModal, setShowTokenModal] = useState<boolean>(false);
    const [customMintInput, setCustomMintInput] = useState<string>('');

    const isSol = mint === SOL_MINT;

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');
        if (!amount || !description) {
            setError('Enter amount and description');
            return;
        }
        setLoading(true);
        try {
            // Переводим SOL в лампорты перед отправкой
            const lamports = Math.round(Number(amount) * 1_000_000_000);
            await onCreate({ amount: lamports.toString(), description, role, mint });
            setAmount('');
            setDescription('');
            setMint(SOL_MINT);
        } catch (e: any) {
            setError(e.message || 'Order creation error');
        } finally {
            setLoading(false);
        }
    };

    const handleTokenButton = () => {
        setCustomMintInput('');
        setShowTokenModal(true);
    };

    const handleAcceptMint = () => {
        if (customMintInput && customMintInput.length >= 32) {
            setMint(customMintInput);
            setShowTokenModal(false);
        }
    };

    const handleSetSol = () => {
        setMint(SOL_MINT);
        setShowTokenModal(false);
    };

    return (
        <form onSubmit={handleSubmit} style={{ margin: '16px 0', background: '#23244a', borderRadius: 12, padding: 20, boxShadow: '0 2px 16px #0002' }}>
            <h3 style={{ color: '#14f195', marginBottom: 16 }}>Create order</h3>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                <button type="button" onClick={() => setRole('seller')} style={{ flex: 1, background: role === 'seller' ? '#9945ff' : '#23244a', color: role === 'seller' ? '#fff' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'all 0.2s' }}>I am a seller</button>
                <button type="button" onClick={() => setRole('buyer')} style={{ flex: 1, background: role === 'buyer' ? '#9945ff' : '#23244a', color: role === 'buyer' ? '#fff' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'all 0.2s' }}>I am a buyer</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                    type="number"
                    placeholder={isSol ? "Amount (in SOL)" : "Amount (in tokens)"}
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    min={0}
                    step={0.000000001}
                    style={{ flex: 1, padding: 12, borderRadius: 8, border: 'none', background: '#191a2e', color: '#fff', fontSize: 16 }}
                />
                <button type="button" onClick={handleTokenButton} style={{ background: '#191a2e', border: 'none', borderRadius: 8, padding: '8px 16px', color: isSol ? '#14f195' : '#fff', fontWeight: 700, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isSol ? <span style={{ fontWeight: 700 }}>SOL</span> : <span style={{ fontWeight: 700 }}>SPL</span>}
                </button>
            </div>
            <textarea
                placeholder="Description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="order-description-textarea"
                rows={3}
            />
            <button type="submit" disabled={loading} style={{ width: '100%', background: '#14f195', color: '#191a2e', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, marginTop: 8, cursor: 'pointer', transition: 'all 0.2s' }}>
                {loading ? 'Creating...' : 'Create'}
            </button>
            {error && <div style={{ color: '#ff3860', marginTop: 8 }}>{error}</div>}
            {showTokenModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: '#000a', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ background: '#23244a', borderRadius: 12, padding: 32, minWidth: 320, boxShadow: '0 2px 16px #0006', display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <h4 style={{ color: '#14f195', marginBottom: 8 }}>Select payment token</h4>
                        <button onClick={handleSetSol} style={{ background: '#191a2e', color: '#14f195', border: 'none', borderRadius: 8, padding: 10, fontWeight: 700, fontSize: 16, marginBottom: 8, cursor: 'pointer' }}>Use SOL</button>
                        <input
                            type="text"
                            placeholder="SPL token mint address"
                            value={customMintInput}
                            onChange={e => setCustomMintInput(e.target.value)}
                            style={{ width: '100%', padding: 12, borderRadius: 8, border: 'none', background: '#191a2e', color: '#fff', fontSize: 16, marginBottom: 8 }}
                        />
                        <button onClick={handleAcceptMint} disabled={!customMintInput || customMintInput.length < 32} style={{ background: '#14f195', color: '#191a2e', border: 'none', borderRadius: 8, padding: 12, fontWeight: 700, fontSize: 16, cursor: customMintInput && customMintInput.length >= 32 ? 'pointer' : 'not-allowed' }}>Accept</button>
                        <button onClick={() => setShowTokenModal(false)} style={{ background: 'transparent', color: '#aaa', border: 'none', borderRadius: 8, padding: 8, fontWeight: 500, fontSize: 15, marginTop: 8, cursor: 'pointer' }}>Cancel</button>
                    </div>
                </div>
            )}
        </form>
    );
}

export default CreateOrder; 