'use client'

import { useEffect } from 'react'
import { Theme } from '@radix-ui/themes'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (dark: boolean) => document.documentElement.classList.toggle('dark', dark)

    apply(mq.matches)
    mq.addEventListener('change', (e) => apply(e.matches))
    return () => mq.removeEventListener('change', (e) => apply(e.matches))
  }, [])

  return (
    <Theme
      accentColor="gray"
      grayColor="gray"
      radius="none"
      appearance="inherit"
      panelBackground="solid"
    >
      {children}
    </Theme>
  )
}
