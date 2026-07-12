const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      remotion: path.resolve(__dirname, 'node_modules/remotion'),
      '@remotion/player': path.resolve(__dirname, 'node_modules/@remotion/player')
    }
    return config
  },
}
module.exports = nextConfig
