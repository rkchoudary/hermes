/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard-live HTTP server runs at :7777 by default; this UI proxies
  // /api/* there so the browser doesn't have to deal with CORS.
  async rewrites() {
    const target = process.env.HERMES_API_URL || 'http://localhost:7777';
    return [
      { source: '/api/:path*', destination: `${target}/api/:path*` },
    ];
  },
};
export default nextConfig;
