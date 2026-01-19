import nextPWA from "next-pwa";

const withPWA = nextPWA({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",
  fallbacks: {
    document: "/offline.html",
  },
});

const nextConfig = {
  reactStrictMode: true,
  turbopack: {}, // keep this to silence Next 16 turbopack warning
};

export default withPWA(nextConfig);
