/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@paperboy/shared"],
  // Media is proxied same-origin by a runtime route handler (app/api/v1/media/…).
  // CSP frame-ancestors (which origins may embed the preview iframe) is set
  // dynamically in middleware.ts so it works on any host without a hard-coded origin.
};
export default nextConfig;
