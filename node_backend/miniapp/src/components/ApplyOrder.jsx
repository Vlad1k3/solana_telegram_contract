import React, { useState } from 'react';

function ApplyOrder({ onApply, onBack }) {
    const [address, setAddress] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!address) {
            setError('Введите адрес контракта');
            return;
        }
        setLoading(true);
        try {
            await onApply(address);
            setAddress('');
        } catch (e) {
            setError(e.message || 'Ошибка применения заказа');
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} style={{ margin: '16px 0', background: '#23244a', borderRadius: 12, padding: 20, boxShadow: '0 2px 16px #0002', position: 'relative' }}>
            <h3 style={{ color: '#14f195', marginBottom: 16 }}>Присоединиться к заказу</h3>
            <input
                type="text"
                placeholder="Адрес контракта"
                value={address}
                onChange={e => setAddress(e.target.value)}
                style={{ width: '100%', marginBottom: 12, padding: 12, borderRadius: 8, border: 'none', background: '#191a2e', color: '#fff', fontSize: 16 }}
            />
            <button type="submit" disabled={loading} style={{ width: '100%', background: '#14f195', color: '#191a2e', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, marginTop: 8, cursor: 'pointer', transition: 'all 0.2s' }}>
                {loading ? 'Присоединение...' : 'Присоединиться'}
            </button>
            <button type="button" onClick={onBack} style={{ width: '100%', background: '#23244a', color: '#14f195', border: '1px solid #14f195', borderRadius: 8, padding: 12, fontWeight: 600, fontSize: 16, marginTop: 8, cursor: 'pointer' }}>Назад</button>
            {error && <div style={{ color: '#ff3860', marginTop: 8 }}>{error}</div>}
        </form>
    );
}

export default ApplyOrder; 