# Solana Escrow dApp (Telegram + Web + Smart Contract)

## Overview

This project is a full-stack escrow platform on Solana, consisting of:
- **Solana smart contract** (Rust, Anchorless)
- **Node.js backend** (Express, SQLite, REST API, Telegram bot)
- **React frontend** (Vite, Wallet Adapter, minimal UI)

It allows two parties (buyer and seller) to create, join, and manage escrow contracts with an optional arbiter. All funds and state transitions are managed on-chain.

---

## Project Structure

```
solana_telegram_contract/
├── src/                # Rust smart contract (lib.rs)
├── node_backend/
│   ├── api.js          # Express REST API
│   ├── db.js           # SQLite DB schema/init
│   ├── solana.js       # Solana helpers
│   ├── package.json    # Backend dependencies
│   ├── miniapp/
│   │   ├── src/        # React frontend (App.jsx, components)
│   │   ├── package.json
│   │   └── ...
│   └── ...
├── Cargo.toml          # Rust contract manifest
└── ...
```

---

## 1. Smart Contract (Rust, `/src/lib.rs`)

### Principle of Operation

- **States:** `Created` → `Initialized` → `Funded` → `SellerConfirmed` → `Completed`/`Cancelled`
- **Actors:** Buyer, Seller, Arbiter
- **Flow:**
  1. One party creates an offer (buyer or seller).
  2. Second party joins.
  3. Buyer funds the escrow (on-chain transfer to vault PDA).
  4. Seller confirms fulfillment.
  5. Buyer confirms receipt (funds released to seller).
  6. Arbiter can resolve disputes at certain stages.
- **All state transitions and fund movements are enforced on-chain.**

### Build & Deploy

```sh
# Install Solana CLI and Rust toolchain if not already
solana --version
rustup --version

# Build the contract
cd solana_telegram_contract
cargo build-bpf --manifest-path Cargo.toml --bpf-out-dir dist

# Deploy to devnet (replace <KEYPAIR> with your deployer keypair)
solana program deploy dist/solana_smart_contract.so --url devnet --keypair <KEYPAIR>
```

- Save the deployed program ID for frontend/backend config.

---

## 2. Backend (Node.js, `/node_backend`)

### Features

- REST API for contract metadata (addresses, roles, status, txids)
- SQLite database for off-chain contract info
- Telegram bot integration (optional, not required for web dApp)
- No private keys stored or used for on-chain actions

### Setup & Run

```sh
cd node_backend
npm install

# Start REST API (default: http://localhost:3000)
npm run api

# (Optional) Start Telegram bot
npm start
```

- The backend only stores public contract metadata and status.
- All on-chain actions are performed by users via wallet adapters.

---

## 3. Frontend (React, `/node_backend/miniapp`)

### Features

- Connect Solana wallet (Phantom, Solflare, WalletConnect, etc.)
- Create/join escrow contracts
- Fund, confirm, and resolve contracts on-chain
- UI reflects on-chain and backend status

### Setup & Run

```sh
cd node_backend/miniapp
npm install

# Start dev server
npm run dev

# Open http://localhost:5173 (or as shown in terminal)
```

- All config (API URL, program ID, arbiter) is hardcoded in `App.jsx` for simplicity.
- The frontend interacts with both the backend (for metadata) and Solana (for transactions).

---

## Deployment

- **Smart contract:** Deploy to Solana devnet/mainnet as above.
- **Backend:** Deploy Node.js app to any server (Heroku, VPS, etc.).
- **Frontend:** Deploy static build (`npm run build`) to any static host (Vercel, Netlify, S3, etc.).
- **Config:** Update hardcoded URLs and program IDs in frontend/backend as needed.

---

## Notes

- All critical actions (funding, confirmation) are performed on-chain via wallet adapter.
- The backend never stores or uses private keys.
- The arbiter is a public key hardcoded in config; only this key can resolve disputes.
- The project is an MVP and can be extended for production (auth, notifications, etc.).

---

## Useful Commands

- **Build contract:** `cargo build-bpf --manifest-path Cargo.toml --bpf-out-dir dist`
- **Deploy contract:** `solana program deploy dist/solana_smart_contract.so --url devnet --keypair <KEYPAIR>`
- **Start backend API:** `npm run api` (in `node_backend`)
- **Start frontend:** `npm run dev` (in `node_backend/miniapp`)

---

## License

MIT (or specify your own) 