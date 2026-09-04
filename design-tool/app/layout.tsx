import type { Metadata } from "next";
import { inter, josefinSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Secure-Test", template: "%s · Secure-Test" },
  description: "PSD assessment authoring interface",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${josefinSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
