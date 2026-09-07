import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import { EB_Garamond, Inter, JetBrains_Mono } from "next/font/google";
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

const analyticsEnabled = process.env.VERCEL === "1";

/** Shared brand typography: interface, machine output, and display. */
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

const LIGHT_THEME_COLOR = "#f5f4f8";
const DARK_THEME_COLOR = "#0b0b0d";
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
      className={`${inter.variable} ${jetbrainsMono.variable} ${ebGaramond.variable}`}
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
