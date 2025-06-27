import React, { useEffect, useState } from 'react';

const API_URL = 'http://localhost:3000';

function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 4) + '...' + addr.slice(-4);
}

function ContractsList({ walletAddress, onRemove, onManage }) {
    const [contracts, setContracts] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState('');

    useEffect(() => {
        if (!walletAddress) return;
        setLoading(true);
        setError(null);
        
        fetch(`${API_URL}/contracts/user/${walletAddress}`)
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

    const handleCopy = (addr) => {
        navigator.clipboard.writeText(addr);
        setCopied(addr);
        setTimeout(() => setCopied(''), 1200);
    };

    if (!walletAddress) return <div>Подключите кошелек для просмотра контрактов.</div>;
    if (loading) return <div>Загрузка контрактов...</div>;
    if (error) return <div>Ошибка загрузки: {error}</div>;
    if (!contracts.length) return <div>Контракты не найдены.</div>;

    return (
        <div style={{ marginTop: 24 }}>
            <h3>Ваши контракты</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {contracts.map(contract => {
                    const isSeller = contract.seller === walletAddress;
                    const isBuyer = contract.buyer === walletAddress;
                    let userRole = isSeller ? 'Продавец' : isBuyer ? 'Покупатель' : '';
                    let badgeColor = contract.status === 'funded' ? '#14f195' : contract.status === 'seller_confirmed' ? '#9945ff' : '#23244a';
                    return (
                        <div key={contract.address || contract.id} className="card">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <span className="status-badge" style={{ background: badgeColor, color: badgeColor === '#14f195' ? '#191a2e' : '#fff' }}>{contract.status}</span>
                                <span className="role-badge">{userRole}</span>
                            </div>
                            <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 4 }}>{contract.description}</div>
                            <div style={{ fontSize: 14, color: '#aaa', marginBottom: 4 }}>
                                Адрес: <span style={{ color: '#14f195', fontWeight: 500 }}>{shortAddr(contract.address)}</span>
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
                                    title="Скопировать адрес"
                                >
                                    {copied === contract.address ? '✓' : '⧉'}
                                </button>
                            </div>
                            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                <button style={{ flex: 1 }} onClick={() => onManage(contract)}>Управлять</button>
                                <button style={{ flex: 1, background: '#ff3860', color: '#fff' }} onClick={() => onRemove(contract.address)}>Удалить</button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default ContractsList; 