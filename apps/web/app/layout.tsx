import type { Metadata } from "next";
import { DEFAULT_LOCALE } from "./lib/locale";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paperboy — reference site",
  description: "Headless content rendered from the Paperboy Delivery API.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={DEFAULT_LOCALE}>
      <body>{children}</body>
    </html>
  );
}
