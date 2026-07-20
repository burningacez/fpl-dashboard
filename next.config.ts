import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The app relies on hand-rolled in-process caches; Next's own data cache
  // must never interpose (all FPL fetches also pass cache: 'no-store').
  poweredByHeader: false,
};

export default nextConfig;
