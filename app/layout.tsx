import type { Metadata, Viewport } from "next";
import "./globals.css";

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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#1f7a4d" },
    { media: "(prefers-color-scheme: dark)", color: "#161613" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
