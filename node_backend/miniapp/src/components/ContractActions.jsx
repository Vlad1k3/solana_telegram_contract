import React from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction, TransactionInstruction, PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';

const ARBITER_PUBKEY = new PublicKey('DVPU9yF5G6TzH8LtfrACYrdAjWmgr8gd7u1xaWSu4sTQ');

function isValidBase58(str) {
    try {
        return !!str && bs58.decode(str);
    } catch {
        return false;
    }
}

function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 4) + '...' + addr.slice(-4);
}

function ContractActions({ contract, open, onClose, onAction, arbiterAddress }) {
    const { publicKey, signTransaction } = useWallet();
    const { connection } = useConnection();
    const [copied, setCopied] = React.useState(false);
    if (!open || !contract) return null;
    const isSeller = publicKey && contract.seller && publicKey.toBase58() === contract.seller;
    const isBuyer = publicKey && contract.buyer && publicKey.toBase58() === contract.buyer;
    const isArbiter = publicKey && arbiterAddress && publicKey.toBase58() === arbiterAddress;
    const status = contract.status;
    const canFund = isBuyer && status === 'initialized';
    const canSellerConfirm = isSeller && status === 'funded';
    const canBuyerConfirm = isBuyer && status === 'seller_confirmed';
    const handleCopy = () => {
        navigator.clipboard.writeText(contract.address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };
    let badgeColor = status === 'funded' ? '#14f195' : status === 'seller_confirmed' ? '#9945ff' : '#23244a';
    let userRole = isSeller ? 'Продавец' : isBuyer ? 'Покупатель' : isArbiter ? 'Арбитр' : '';
    return (
        <div style={{
            position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh',
            background: 'rgba(25,26,46,0.85)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
            <div style={{ background: '#23244a', padding: 32, borderRadius: 16, minWidth: 340, boxShadow: '0 4px 32px #0005', color: '#fff', maxWidth: 420 }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>{contract.description}</div>
                    <span style={{ background: badgeColor, color: '#191a2e', borderRadius: 6, padding: '2px 10px', fontWeight: 700, fontSize: 14 }}>{status}</span>
                </div>
                <div style={{ fontSize: 14, color: '#aaa', marginBottom: 8 }}>
                    <span>Адрес: <span style={{ fontFamily: 'monospace', color: '#fff' }}>{shortAddr(contract.address)}</span></span>
                    <button onClick={handleCopy} style={{ marginLeft: 8, background: 'none', border: 'none', color: '#14f195', cursor: 'pointer', fontWeight: 700 }}>{copied ? '✓' : '⧉'}</button>
                </div>
                <div style={{ fontSize: 14, color: '#aaa', marginBottom: 8 }}>
                    <span>Сумма: <span style={{ color: '#14f195', fontWeight: 600 }}>{contract.amount}</span></span>
                </div>
                <div style={{ fontSize: 14, color: '#aaa', marginBottom: 16 }}>
                    <span>Ваша роль: <span style={{ color: '#fff', fontWeight: 600 }}>{userRole}</span></span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 8 }}>
                    <button style={{ width: '100%', background: canFund ? '#14f195' : '#23244a', color: canFund ? '#191a2e' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, cursor: canFund ? 'pointer' : 'not-allowed', opacity: canFund ? 1 : 0.6 }} onClick={() => onAction('fund')} disabled={!canFund}>Фандинг</button>
                    <button style={{ width: '100%', background: canSellerConfirm ? '#9945ff' : '#23244a', color: canSellerConfirm ? '#fff' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, cursor: canSellerConfirm ? 'pointer' : 'not-allowed', opacity: canSellerConfirm ? 1 : 0.6 }} onClick={() => onAction('confirm')} disabled={!canSellerConfirm}>Продавец: подтвердить выполнение</button>
                    <button style={{ width: '100%', background: canBuyerConfirm ? '#14f195' : '#23244a', color: canBuyerConfirm ? '#191a2e' : '#aaa', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, cursor: canBuyerConfirm ? 'pointer' : 'not-allowed', opacity: canBuyerConfirm ? 1 : 0.6 }} onClick={() => onAction('buyer_confirm')} disabled={!canBuyerConfirm}>Покупатель: подтвердить получение</button>
                    {isArbiter && <button style={{ width: '100%', background: '#23244a', color: '#14f195', border: '1px solid #14f195', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, cursor: 'pointer' }} onClick={() => onAction('arbiter_confirm')}>Арбитраж: подтвердить</button>}
                    {isArbiter && <button style={{ width: '100%', background: '#23244a', color: '#ff3860', border: '1px solid #ff3860', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 16, cursor: 'pointer' }} onClick={() => onAction('arbiter_cancel')}>Арбитраж: отменить</button>}
                </div>
                <button style={{ width: '100%', background: '#23244a', color: '#aaa', border: 'none', borderRadius: 8, padding: 12, fontWeight: 600, fontSize: 15, marginTop: 8, cursor: 'pointer' }} onClick={onClose}>Закрыть</button>
            </div>
        </div>
    );
}

export default ContractActions; 