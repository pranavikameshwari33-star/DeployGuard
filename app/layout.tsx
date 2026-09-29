import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Open_Sans } from "next/font/google";
import "./globals.css";

// The only font in the app. Self-hosted by next/font (no browser requests to Google).
const openSans = Open_Sans({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "DeployGuard",
  description: "Deployment monitoring and risk analysis",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={openSans.className}>
      <body>{children}</body>
    </html>
  );
}
