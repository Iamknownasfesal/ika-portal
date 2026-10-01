/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOLANA_RPC?: string;
  readonly VITE_PROGRAM_ID?: string;
  readonly VITE_IKA_DWALLET_PROGRAM_ID?: string;
  readonly VITE_IKA_GRPC_URL?: string;
  readonly VITE_RELAYER_URL?: string;
  readonly VITE_ESPLORA_URL?: string;
  readonly VITE_BTC_EXPLORER?: string;
  readonly VITE_SEPOLIA_RPC?: string;
  readonly VITE_BASE_SEPOLIA_RPC?: string;
  readonly VITE_NEAR_PROXY_URL?: string;
  readonly VITE_MOCK_DEPOSIT_BTC?: string;
  readonly VITE_MOCK_DEPOSIT_EVM?: string;
  readonly VITE_INTEGRATOR_FEE_RECIPIENT?: string;
  readonly VITE_INTEGRATOR_FEE_BPS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
