import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser only talks to the orchestrator (via /api); the orchestrator talks MCP.
const orchestrator = process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:8100';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: orchestrator,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, '')
      }
    }
  }
});
