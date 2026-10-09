import type { Metadata } from "next";
import { inter, josefinSans } from "./fonts";
import { PRODUCT_NAME } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
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
