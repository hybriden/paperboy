/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@paperboy/shared", "@paperboycms/client", "@paperboycms/preview"],
  // jsdom (via isomorphic-dompurify) can't be webpack-bundled — it reads its
  // default stylesheet from disk at runtime. Load it from node_modules instead.
  serverExternalPackages: ["isomorphic-dompurify", "jsdom"],
  // Media is proxied same-origin by a runtime route handler (app/api/v1/media/…).
  // CSP frame-ancestors (which origins may embed the preview iframe) is set
  // dynamically in middleware.ts so it works on any host without a hard-coded origin.
  webpack: (config) => {
    // The transpiled workspace packages use explicit .js specifiers on relative TS
    // imports (Node-ESM/nodenext-valid). When webpack consumes their .ts SOURCE via
    // transpilePackages, map a .js import to the .ts file it resolves to at build.
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
export default nextConfig;
