import { copyManifest, outDir, targetBuild } from './vite.shared.ts'

/** Background service worker: ES module (manifest `"type": "module"`). */
export default targetBuild('src/background/index.ts', 'es', 'background.js', true)

export { copyManifest, outDir }
