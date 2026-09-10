import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Standalone output keeps the runtime image small; see Dockerfile.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
}

export default nextConfig
