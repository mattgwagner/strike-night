// Separate from vite.config.ts: the Cloudflare plugin breaks under vitest.
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
