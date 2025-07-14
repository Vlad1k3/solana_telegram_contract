import React, { useState } from 'react';

interface CreateOrderParams {
    amount: string; // в лампортах
    description: string;
    role: 'buyer' | 'seller';
}
interface CreateOrderProps {
    onCreate: (params: CreateOrderParams) => Promise<void>;
}

function CreateOrder({ onCreate }: CreateOrderProps) {
    const [amount, setAmount] = useState<string>(''); // в SOL
    const [description, setDescription] = useState<string>('');
    const [role, setRole] = useState<'buyer' | 'seller'>('seller');
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string>('');

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
            await onCreate({ amount: lamports.toString(), description, role });
            setAmount('');
            setDescription('');
        } catch (e: any) {
            setError(e.message || 'Order creation error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} style={{ margin: '16px 0', background: '#23244a', borderRadius: 12, padding: 20, boxShadow: '0 2px 16px #0002' }}>
            <h3 style={{ color: '#14f195', marginBottom: 16 }}>Create order</h3>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                <button type="button" onClick={() => setRole('seller')} style={{ flex: 1, background: role === 'seller' ? '#9945ff' : '#23244a', color: role === 'seller' ? '#fff' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'all 0.2s' }}>I am a seller</button>
                <button type="button" onClick={() => setRole('buyer')} style={{ flex: 1, background: role === 'buyer' ? '#9945ff' : '#23244a', color: role === 'buyer' ? '#fff' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'all 0.2s' }}>I am a buyer</button>
            </div>
            <input
                type="number"
                placeholder="Amount (in SOL)"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                min={0}
                step={0.000000001}
                style={{ width: '100%', marginBottom: 12, padding: 12, borderRadius: 8, border: 'none', background: '#191a2e', color: '#fff', fontSize: 16 }}
            />
            <input
                type="text"
                placeholder="Description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                style={{ width: '100%', marginBottom: 12, padding: 12, borderRadius: 8, border: 'none', background: '#191a2e', color: '#fff', fontSize: 16 }}
            />
            <button type="submit" disabled={loading} style={{ width: '100%', background: '#14f195', color: '#191a2e', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, marginTop: 8, cursor: 'pointer', transition: 'all 0.2s' }}>
                {loading ? 'Creating...' : 'Create'}
            </button>
            {error && <div style={{ color: '#ff3860', marginTop: 8 }}>{error}</div>}
        </form>
    );
}

export default CreateOrder; 