'use client'

import { useState, useCallback, createContext, useContext, ReactNode } from 'react'
import * as Sentry from '@sentry/nextjs'
import { WindowState } from './types'

interface WindowManagerContextType {
  windows: WindowState[]
  openWindow: (window: Omit<WindowState, 'zIndex' | 'isFocused'>) => void
  closeWindow: (id: string) => void
  minimizeWindow: (id: string) => void
  maximizeWindow: (id: string) => void
  restoreWindow: (id: string) => void
  focusWindow: (id: string) => void
  updateWindowPosition: (id: string, x: number, y: number) => void
  updateWindowSize: (id: string, width: number, height: number) => void
  topZIndex: number
}

const WindowManagerContext = createContext<WindowManagerContextType | null>(null)

export function useWindowManager() {
  const context = useContext(WindowManagerContext)
  if (!context) {
    throw new Error('useWindowManager must be used within WindowManagerProvider')
  }
  return context
}

export function WindowManagerProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<WindowState[]>([])
  const [topZIndex, setTopZIndex] = useState(100)

  const openWindow = useCallback((window: Omit<WindowState, 'zIndex' | 'isFocused'>) => {
    setTopZIndex(currentZ => {
      const newZ = currentZ + 1
      setWindows(prev => {
        const existing = prev.find(w => w.id === window.id)
        const isNewWindow = !existing

        if (isNewWindow) {
          Sentry.logger.info('window_opened', {
            window_id: window.id,
            window_title: window.title,
            window_icon: window.icon,
            dimensions: {
              width: window.width,
              height: window.height,
              x: window.x,
              y: window.y
            }
          })

          // Track window opens
          Sentry.metrics.increment('desktop.windows.opened', 1, {
            tags: { window_type: window.id.split('-')[0] }
          })

          // Track active window count
          Sentry.metrics.gauge('desktop.windows.active', prev.length + 1)
        } else {
          Sentry.logger.info('window_focused', {
            window_id: window.id,
            was_minimized: existing.isMinimized
          })

          Sentry.metrics.increment('desktop.windows.focused', 1, {
            tags: { window_type: window.id.split('-')[0] }
          })
        }

        if (existing) {
          if (existing.isMinimized) {
            return prev.map(w =>
              w.id === window.id
                ? { ...w, isMinimized: false, isFocused: true, zIndex: newZ }
                : { ...w, isFocused: false }
            )
          }
          return prev.map(w =>
            w.id === window.id
              ? { ...w, isFocused: true, zIndex: newZ }
              : { ...w, isFocused: false }
          )
        }
        return [
          ...prev.map(w => ({ ...w, isFocused: false })),
          { ...window, zIndex: newZ, isFocused: true }
        ]
      })
      return newZ
    })
  }, [])

  const closeWindow = useCallback((id: string) => {
    setWindows(prev => {
      const window = prev.find(w => w.id === id)

      if (window) {
        Sentry.logger.info('window_closed', {
          window_id: id,
          window_title: window.title
        })

        Sentry.metrics.increment('desktop.windows.closed', 1, {
          tags: { window_type: id.split('-')[0] }
        })

        // Track active window count
        Sentry.metrics.gauge('desktop.windows.active', prev.length - 1)
      }

      return prev.filter(w => w.id !== id)
    })
  }, [])

  const minimizeWindow = useCallback((id: string) => {
    setWindows(prev => {
      const window = prev.find(w => w.id === id)

      if (window) {
        Sentry.logger.info('window_minimized', {
          window_id: id,
          window_title: window.title
        })

        Sentry.metrics.increment('desktop.windows.minimized', 1, {
          tags: { window_type: id.split('-')[0] }
        })
      }

      return prev.map(w =>
        w.id === id ? { ...w, isMinimized: true, isFocused: false } : w
      )
    })
  }, [])

  const maximizeWindow = useCallback((id: string) => {
    setWindows(prev => {
      const window = prev.find(w => w.id === id)

      if (window) {
        const newMaximizedState = !window.isMaximized

        Sentry.logger.info('window_maximized', {
          window_id: id,
          window_title: window.title,
          is_maximized: newMaximizedState
        })

        Sentry.metrics.increment('desktop.windows.maximized', 1, {
          tags: {
            window_type: id.split('-')[0],
            action: newMaximizedState ? 'maximize' : 'restore'
          }
        })
      }

      return prev.map(w =>
        w.id === id ? { ...w, isMaximized: !w.isMaximized } : w
      )
    })
  }, [])

  const restoreWindow = useCallback((id: string) => {
    setTopZIndex(currentZ => {
      const newZ = currentZ + 1
      setWindows(prev => prev.map(w =>
        w.id === id
          ? { ...w, isMinimized: false, isFocused: true, zIndex: newZ }
          : { ...w, isFocused: false }
      ))
      return newZ
    })
  }, [])

  const focusWindow = useCallback((id: string) => {
    setTopZIndex(currentZ => {
      const newZ = currentZ + 1
      setWindows(prev => prev.map(w =>
        w.id === id
          ? { ...w, isFocused: true, zIndex: newZ }
          : { ...w, isFocused: false }
      ))
      return newZ
    })
  }, [])

  const updateWindowPosition = useCallback((id: string, x: number, y: number) => {
    setWindows(prev => prev.map(w =>
      w.id === id ? { ...w, x, y } : w
    ))
  }, [])

  const updateWindowSize = useCallback((id: string, width: number, height: number) => {
    setWindows(prev => prev.map(w =>
      w.id === id ? { ...w, width, height } : w
    ))
  }, [])

  return (
    <WindowManagerContext.Provider value={{
      windows,
      openWindow,
      closeWindow,
      minimizeWindow,
      maximizeWindow,
      restoreWindow,
      focusWindow,
      updateWindowPosition,
      updateWindowSize,
      topZIndex
    }}>
      {children}
    </WindowManagerContext.Provider>
  )
}
