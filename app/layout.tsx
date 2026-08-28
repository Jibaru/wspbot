import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

/**
 * Geist, the brand's typeface: Sans for prose, Mono for labels and data. Loaded once here rather
 * than per page, so the dashboard and the landing share one copy and one set of variables.
 */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

/**
 * The icon set in `public/` is generated, not drawn by hand — regenerate it with
 * `node .claude/skills/icongen/scripts/icongen.mjs --config public/icon.config.json`,
 * which carries every resolved setting, rather than by reconstructing the flags.
 */

export const metadata: Metadata = {
  title: "wspbot",
  description: "A WhatsApp bot that answers when tagged.",
  icons: {
    icon: [
      // .ico first, for the browsers that ignore SVG favicons entirely.
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      // Declarative rather than the generator's inline script: `media` on a <link rel="icon">
      // is understood by the browser, so the swap needs no JavaScript and survives a hard reload.
      {
        url: "/favicon-dark.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: dark)",
      },
    ],
    // Deliberately the square PNG: iOS applies its own mask, and a pre-rounded source is
    // clipped twice — visibly, at the corners.
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
};

/** `themeColor` lives here, not in `metadata` — deprecated there since Next 14. */
export const viewport: Viewport = {
  themeColor: "#0d0d0d",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
