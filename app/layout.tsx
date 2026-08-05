import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://redactify.varun-bdk.workers.dev"),
  title: "Redactify — Local PDF redaction",
  description:
    "Find, review, and permanently redact sensitive PDF content entirely in your browser.",
  openGraph: {
    title: "Redactify — Redact with surgical precision",
    description:
      "Find, review, and permanently redact sensitive PDF content entirely in your browser.",
    images: ["/og-redesign.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Redactify — Redact with surgical precision",
    description:
      "Find, review, and permanently redact sensitive PDF content entirely in your browser.",
    images: ["/og-redesign.png"],
  },
  icons: {
    icon: "/favicon.svg?v=2",
    shortcut: "/favicon.svg?v=2",
    apple: "/favicon.svg?v=2",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
