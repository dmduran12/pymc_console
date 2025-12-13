import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export - generates pure HTML/CSS/JS in 'out' directory
  // No Node.js runtime needed - backend serves these files directly
  output: 'export',
  
  // For static export, we need trailing slashes for proper routing
  trailingSlash: true,
  
  // Base path can be configured if serving from subdirectory
  // basePath: '/dashboard',
  
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
