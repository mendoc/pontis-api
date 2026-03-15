import type { Metadata } from 'next'
import { ThemeProvider } from './components/ThemeProvider'
import './globals.css'

export const metadata: Metadata = { title: 'Pontis' }

const themeScript = `(function(){try{var d=document.documentElement,dark=window.matchMedia('(prefers-color-scheme: dark)').matches;if(dark)d.classList.add('dark');}catch(e){}})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
