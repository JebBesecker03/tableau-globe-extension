import dns from 'node:dns';
import { defineConfig } from 'vite';

// Node can resolve "localhost" to IPv6 only (::1). Prefer IPv4 so clients that
// resolve localhost to 127.0.0.1 (e.g. Tableau Desktop) can still reach the server.
dns.setDefaultResultOrder('ipv4first');

export default defineConfig({
  // Relative asset paths so the built folder can be hosted under any sub-path.
  base: './',
  // 8766 so this experimental fork can run alongside the stable globe (8765).
  server: { port: 8766, strictPort: true },
  preview: { port: 8766, strictPort: true },
  build: { chunkSizeWarningLimit: 2000 },
});
