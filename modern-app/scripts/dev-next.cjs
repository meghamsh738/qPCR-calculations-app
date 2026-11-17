const path = require('node:path')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { createRequire } = require('node:module')

const modernAppRoot = path.resolve(__dirname, '..')
const moduleRoot = path.resolve(modernAppRoot, '..')
const moduleRequire = createRequire(path.join(moduleRoot, 'package.json'))
const runtime = moduleRequire('./desktop/electron/next-runtime.cjs')

let apiChild = null
let viteServer = null
let stopping = false

function stopApi(signal = 'SIGTERM') {
  if (apiChild && apiChild.exitCode === null && !apiChild.killed) apiChild.kill(signal)
}

async function stop(signal) {
  if (stopping) return
  stopping = true
  try {
    if (viteServer) await viteServer.close()
  } finally {
    stopApi(signal || 'SIGTERM')
  }
}

async function main() {
  process.once('SIGINT', () => { void stop('SIGINT') })
  process.once('SIGTERM', () => { void stop('SIGTERM') })

  const layout = runtime.resolveRuntimeLayout({ projectRoot: moduleRoot })
  runtime.ensureRuntimeLayout(layout)
  if (!fs.existsSync(layout.pythonPath)) {
    throw new Error(`The isolated qPCR Planner Python environment is missing: ${layout.pythonPath}`)
  }

  apiChild = spawn(layout.pythonPath, ['-I', layout.backendScript], {
    cwd: modernAppRoot,
    env: runtime.buildBackendEnvironment(process.env, layout, modernAppRoot),
    stdio: 'inherit',
    windowsHide: true,
  })
  apiChild.once('error', (error) => {
    console.error(`The qPCR Planner Next API could not start: ${error.message}`)
    process.exitCode = 1
    void stop('SIGTERM')
  })
  apiChild.once('exit', (code) => {
    if (!stopping) {
      console.error(`The qPCR Planner Next API stopped unexpectedly (code ${code}).`)
      process.exitCode = code === null ? 1 : code
      void stop('SIGTERM')
    }
  })

  await runtime.waitForOwnedHealth(apiChild)
  const { createServer } = await import('vite')
  viteServer = await createServer({
    configFile: path.join(modernAppRoot, 'vite.config.ts'),
    root: modernAppRoot,
  })
  await viteServer.listen()
  viteServer.printUrls()

}

main().catch(async (error) => {
  console.error(`The qPCR Planner Next development runtime could not start: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
  await stop('SIGTERM')
})
