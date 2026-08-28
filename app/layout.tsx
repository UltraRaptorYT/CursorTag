import type { Metadata } from "next";
import "./globals.css";

function resolveMetadataBase() {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const candidate = configuredUrl || vercelUrl || "http://localhost:3000";
  const absoluteUrl = /^https?:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`;

  try {
    return new URL(absoluteUrl);
  } catch {
    return new URL("http://localhost:3000");
  }
}

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: "Cursor Tag — Tilt. Chase. Tag.",
  description: "A browser-based multiplayer party game where every phone becomes a live cursor.",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" },
    ],
  },
  openGraph: {
    title: "Cursor Tag — Tilt. Chase. Tag.",
    description: "Every phone becomes a cursor. Catch someone before the clock catches you.",
    type: "website",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "Cursor Tag multiplayer chase game" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Cursor Tag — Tilt. Chase. Tag.",
    description: "Every phone becomes a cursor. Catch someone before the clock catches you.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
