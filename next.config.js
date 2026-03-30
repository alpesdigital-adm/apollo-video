/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['fluent-ffmpeg'],
  },
  webpack: (config) => {
    config.externals = [...(config.externals || []), { 'fluent-ffmpeg': 'commonjs fluent-ffmpeg' }];
    return config;
  },
}
module.exports = nextConfig
