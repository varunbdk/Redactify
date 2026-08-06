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
  title: "helpredact.com — Local PDF redaction",
  description:
    "Find, review, and permanently redact sensitive PDF content entirely in your browser.",
  openGraph: {
    title: "helpredact.com — Get sensitive details redacted, instantly!",
    description:
      "Find, review, and permanently redact sensitive PDF content entirely in your browser.",
    images: ["/og-warm.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "helpredact.com — Get sensitive details redacted, instantly!",
    description:
      "Find, review, and permanently redact sensitive PDF content entirely in your browser.",
    images: ["/og-warm.png"],
  },
  icons: {
    icon: "/favicon.svg?v=4",
    shortcut: "/favicon.svg?v=4",
    apple: "/favicon.svg?v=4",
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
