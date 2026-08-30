import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import {
  EB_Garamond,
  Geist,
  Geist_Mono,
  Inter,
  JetBrains_Mono,
} from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

export const metadata: Metadata = {
  applicationName: "OpenCoven Agents",
  description:
    "Create autonomous OpenCoven agents that run in isolated cloud sandboxes.",
  metadataBase: new URL(process.env.APP_ORIGIN ?? "http://localhost:3036"),
  title: {
    default: "OpenCoven Agents",
    template: "%s · OpenCoven",
  },
};

export const viewport = {
  maximumScale: 1,
};

const analyticsEnabled = process.env.VERCEL === "1";

const geist = Geist({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

/**
 * The run console's three faces: Inter for the interface, JetBrains Mono for
 * anything the machine produced, EB Garamond for the one question each
 * composer asks. Declared here because `next/font` has to run at module scope
 * in a server file; only the console applies them.
 */
const inter = Inter({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["400", "500", "600"],
});

const ebGaramond = EB_Garamond({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-eb-garamond",
  weight: ["400", "500"],
});

const LIGHT_THEME_COLOR = "hsl(0 0% 100%)";
const DARK_THEME_COLOR = "hsl(240deg 10% 3.92%)";
const THEME_COLOR_SCRIPT = `\
(function() {
  var html = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  function updateThemeColor() {
    var isDark = html.classList.contains('dark');
    meta.setAttribute('content', isDark ? '${DARK_THEME_COLOR}' : '${LIGHT_THEME_COLOR}');
  }
  var observer = new MutationObserver(updateThemeColor);
  observer.observe(html, { attributes: true, attributeFilter: ['class'] });
  updateThemeColor();
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      className={`${geist.variable} ${geistMono.variable} ${inter.variable} ${jetbrainsMono.variable} ${ebGaramond.variable}`}
      /**
       * The OpenCoven palette, applied once at the root so every surface --
       * console, chat, auth -- inherits it. The theme provider puts `.dark`
       * on this same element, which is what the dark token block pairs with.
       */
      data-brand="opencoven"
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: "Required"
          dangerouslySetInnerHTML={{
            __html: THEME_COLOR_SCRIPT,
          }}
        />
      </head>
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableSystem
        >
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
        {analyticsEnabled ? <Analytics /> : null}
      </body>
    </html>
  );
}
