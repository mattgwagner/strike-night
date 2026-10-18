import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [cloudflare()],
  define: { __BUILD__: JSON.stringify(process.env.VITE_BUILD?.slice(0, 7) ?? 'dev') },
  server: { port: 5190, host: true, allowedHosts: ['.ts.net'] },
  build: { chunkSizeWarningLimit: 4000 },
});
