import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";
import { configuredApplicationBasePath } from "./lib/application-path";

const basePath = configuredApplicationBasePath(process.env);
const loginDestination = `${basePath}/login`;
const rootDestination = basePath || "/agents";

const nextConfig: NextConfig = {
  ...(basePath
    ? {
        assetPrefix: "/demo-assets",
        basePath,
      }
    : {}),
  cacheComponents: true,
  devIndicators: false,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  experimental: {
    cachedNavigations: true,
    inlineCss: true,
    prefetchInlining: true,
    turbopackFileSystemCacheForDev: true,
  },
  images: {
    remotePatterns: [
      {
        hostname: "avatar.vercel.sh",
      },
      {
        hostname: "*.public.blob.vercel-storage.com",
        protocol: "https",
      },
    ],
  },
  logging: {
    fetches: {
      fullUrl: false,
    },
    incomingRequests: false,
  },
  poweredByHeader: false,
  reactCompiler: true,
  redirects: async () => [
    {
      basePath: false,
      destination: rootDestination,
      permanent: false,
      source: "/",
    },
    {
      basePath: false,
      destination: loginDestination,
      permanent: false,
      source: "/register",
    },
  ],
};

export default withBotId(nextConfig);
