import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cada compilación lleva su número de versión (el commit en Railway; si no, la hora de compilar).
// Va dentro de la app (__BUILD_ID__) y en /version.json: si no coinciden, salió una versión nueva y se ofrece «Actualizar».
const BUILD_ID = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 12) || Date.now().toString(36)

function versionFile() {
  return {
    name: 'ktracho-version',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
})
