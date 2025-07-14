import {
  HuobiWalletAdapter,
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter
} from '@solana/wallet-adapter-wallets';
import { SolanaAdapter } from '@reown/appkit-adapter-solana/react';
import { solana, solanaDevnet } from '@reown/appkit/networks';
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useDisconnect
} from '@reown/appkit/react';

const solanaAdapter = new SolanaAdapter({
  wallets: [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new TrustWalletAdapter(),
    new HuobiWalletAdapter()
  ]
});

const modal = createAppKit({
  adapters: [solanaAdapter],
  networks: [solana, solanaDevnet],
  projectId: '38295d3d88057287538e78184720b5fb', // замените на ваш projectId
  metadata: {
    name: 'Miniapp',
    description: 'Solana Escrow Miniapp',
    url: '',
    icons: []
  }
});

export { modal, useAppKit, useAppKitAccount, useDisconnect }; 