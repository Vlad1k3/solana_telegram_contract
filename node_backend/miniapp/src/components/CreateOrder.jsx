import React, { useState } from 'react';

function CreateOrder({ onCreate }) {
    const [amount, setAmount] = useState('');
    const [description, setDescription] = useState('');
    const [role, setRole] = useState('seller');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!amount || !description) {
            setError('Введите сумму и описание');
            return;
        }
        setLoading(true);
        try {
            await onCreate({ amount, description, role });
            setAmount('');
            setDescription('');
        } catch (e) {
            setError(e.message || 'Ошибка создания заказа');
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} style={{ margin: '16px 0', background: '#23244a', borderRadius: 12, padding: 20, boxShadow: '0 2px 16px #0002' }}>
            <h3 style={{ color: '#14f195', marginBottom: 16 }}>Создать заказ</h3>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                <button type="button" onClick={() => setRole('seller')} style={{ flex: 1, background: role === 'seller' ? '#9945ff' : '#23244a', color: role === 'seller' ? '#fff' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'all 0.2s' }}>Я продавец</button>
                <button type="button" onClick={() => setRole('buyer')} style={{ flex: 1, background: role === 'buyer' ? '#9945ff' : '#23244a', color: role === 'buyer' ? '#fff' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'all 0.2s' }}>Я покупатель</button>
            </div>
            <input
                type="number"
                placeholder="Сумма (в лампортах)"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                min={0}
                style={{ width: '100%', marginBottom: 12, padding: 12, borderRadius: 8, border: 'none', background: '#191a2e', color: '#fff', fontSize: 16 }}
            />
            <input
                type="text"
                placeholder="Описание"
                value={description}
                onChange={e => setDescription(e.target.value)}
                style={{ width: '100%', marginBottom: 12, padding: 12, borderRadius: 8, border: 'none', background: '#191a2e', color: '#fff', fontSize: 16 }}
            />
            <button type="submit" disabled={loading} style={{ width: '100%', background: '#14f195', color: '#191a2e', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, marginTop: 8, cursor: 'pointer', transition: 'all 0.2s' }}>
                {loading ? 'Создание...' : 'Создать'}
            </button>
            {error && <div style={{ color: '#ff3860', marginTop: 8 }}>{error}</div>}
        </form>
    );
}

export default CreateOrder; 