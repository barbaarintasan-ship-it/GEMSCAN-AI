/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The website is a standalone app that only shares Supabase with the mobile
  // app — it has no dependency on the mobile codebase. Keeping this config
  // minimal so the two apps stay decoupled.
};

export default nextConfig;
