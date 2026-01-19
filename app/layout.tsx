import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Whiplash",
  manifest: "/manifest.json",
  themeColor: "#0b0b0f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
