import React, { useState } from 'react';

interface ApplyOrderProps {
    onApply: (address: string) => Promise<void>;
    onBack: () => void;
}

function ApplyOrder({ onApply, onBack }: ApplyOrderProps) {
    const [address, setAddress] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string>('');

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');
        if (!address) {
            setError('Enter contract address');
            return;
        }
        setLoading(true);
        try {
            await onApply(address);
            setAddress('');
        } catch (e: any) {
            setError(e.message || 'Order apply error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} style={{ margin: '16px 0', background: '#23244a', borderRadius: 12, padding: 20, boxShadow: '0 2px 16px #0002', position: 'relative' }}>
            <h3 style={{ color: '#14f195', marginBottom: 16 }}>Join order</h3>
            <input
                type="text"
                placeholder="Contract address"
                value={address}
                onChange={e => setAddress(e.target.value)}
                className="apply-order-input"
            />
            <button type="submit" disabled={loading} style={{ width: '100%', background: '#14f195', color: '#191a2e', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, marginTop: 8, cursor: 'pointer', transition: 'all 0.2s' }}>
                {loading ? 'Joining...' : 'Join'}
            </button>
            <button type="button" onClick={onBack} style={{ width: '100%', background: '#23244a', color: '#14f195', border: '1px solid #14f195', borderRadius: 8, padding: 12, fontWeight: 600, fontSize: 16, marginTop: 8, cursor: 'pointer' }}>Back</button>
            {error && <div style={{ color: '#ff3860', marginTop: 8 }}>{error}</div>}
        </form>
    );
}

export default ApplyOrder; 