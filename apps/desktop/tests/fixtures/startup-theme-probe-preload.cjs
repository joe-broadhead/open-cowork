const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('coworkApi', {
  on: {
    runtimeLoadingStatus: () => () => undefined,
  },
  app: {
    config: async () => ({ branding: { name: '' } }),
    exportDiagnostics: async () => '',
  },
  runtime: {
    awaitInitialization: () => new Promise(() => undefined),
    restart: async () => undefined,
  },
  clipboard: {
    writeText: async () => true,
  },
})
