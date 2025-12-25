import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'out',
    chunkSizeWarningLimit: 1100, // maplibre-gl is ~1MB, recharts ~500KB
    rollupOptions: {
      output: {
        manualChunks: {
          // Split large dependencies into separate chunks for better caching
          // These are loaded lazily via route-based code splitting
          'maplibre-gl': ['maplibre-gl'],
          'recharts': ['recharts'],
          'leaflet': ['leaflet', 'react-leaflet'],
        },
      },
    },
  },
  server: {
    port: 3000,
    // Proxy API requests to backend during development
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
