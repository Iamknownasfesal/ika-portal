import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Node globals (Buffer, process, global) are installed by src/polyfills.ts, loaded before the app.
  define: {
    'process.env.NODE_DEBUG': 'false',
  },
  resolve: {
    alias: {
      // The signer lazily imports @grpc/grpc-js for its Node transport only.
      // Browsers use the gRPC-web transport, so never bundle grpc-js.
      '@grpc/grpc-js': here('./src/shims/grpc-js.ts'),
    },
  },
  optimizeDeps: {
    // Ships raw .ts inside node_modules: make sure it is pre-bundled (transpiled).
    include: ['@ika-portal/signer > @ika.xyz/pre-alpha-solana-client/grpc-web'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
});
