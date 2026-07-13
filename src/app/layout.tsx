import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import Providers from "./providers";

/**
 * Applies the saved theme (System/Light/Dark) + accent BEFORE first paint so
 * there's no flash. Runs beforeInteractive (hoisted to <head>). Default is dark
 * (the app's original look) when nothing is stored. Keep in sync with
 * src/store/settings.ts. See the Settings "General" tab.
 */
const THEME_INIT = `(function(){try{
  var t=localStorage.getItem('theme')||'dark';
  var m=t==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;
  var e=document.documentElement;
  e.classList.remove('light','dark');e.classList.add(m==='light'?'light':'dark');
  var a=localStorage.getItem('accent');if(a){e.style.setProperty('--color-accent',a);}
  var ah=localStorage.getItem('accentHover');if(ah){e.style.setProperty('--color-accent-hover',ah);}
}catch(e){}})();`;

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OpenAgent",
  description: "OpenAgent — built with Next.js and the OpenAI Agents SDK.",
};

export const viewport: Viewport = {
  themeColor: "#212121",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="min-h-screen bg-main font-sans text-text-primary antialiased">
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT}
        </Script>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
