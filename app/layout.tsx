import type { Metadata } from "next";
import "./globals.css";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Cursor Tag — Tilt. Chase. Tag.",
  description: "A browser-based multiplayer party game where every phone becomes a live cursor.",
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
