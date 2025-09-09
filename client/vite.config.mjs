import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // All requests starting with /api will be forwarded to the backend
      '/api': {
        target: 'http://localhost:3001', //  backend URL
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '') // optional: remove /api prefix
      }
    }
  }
});
