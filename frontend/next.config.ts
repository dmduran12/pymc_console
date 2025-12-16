import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export - generates pure HTML/CSS/JS in 'out' directory
  // No Node.js runtime needed - backend serves these files directly
  output: 'export',
  
  // SPA mode: all routes serve the same index.html, client-side routing handles navigation
  // This works with upstream CherryPy's default() fallback without any patches
  // trailingSlash is NOT set - we want clean URLs like /packets not /packets/
  
  // Silence Next 16 warning when using a webpack() config
  turbopack: {},
  
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Disable code splitting/chunking - bundle everything into fewer files
      config.optimization.splitChunks = {
        cacheGroups: {
          default: false,
          vendors: false,
        },
      };
      config.optimization.runtimeChunk = false;
    }
    return config;
  },
  
  // Image optimization not available in static export
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
