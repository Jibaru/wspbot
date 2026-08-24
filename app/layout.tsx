import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "wspbot",
  description: "A WhatsApp bot that answers when tagged.",
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
