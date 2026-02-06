/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    selectDirectory: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>
    ensureDirectories: (paths: Record<string, string>) => Promise<{ ok: boolean; message?: string }>
    getAppInfo: () => Promise<{ name: string; version: string; platform: string }>
    getDefaultPaths: () => Promise<Record<string, string>>
  }
}
