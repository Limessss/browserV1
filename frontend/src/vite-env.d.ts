/// <reference types="vite/client" />

interface AntBridge {
  ping: () => Promise<string>
  version: () => Promise<{ name: string; version: string }>
}

declare global {
  interface Window {
    antBridge: AntBridge
  }
}

export {}
