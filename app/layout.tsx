import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "DeployGuard",
  description: "AI DevOps pipeline agent",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          margin: 0,
          padding: "3rem 1.5rem",
          background: "#0b0e14",
          color: "#e6e9ef",
        }}
      >
        {children}
      </body>
    </html>
  );
}
