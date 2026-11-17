const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')

const modernAppRoot = path.resolve(__dirname, '..')
const moduleRoot = path.resolve(modernAppRoot, '..')
const moduleRequire = createRequire(path.join(moduleRoot, 'package.json'))
const runtime = moduleRequire('./desktop/electron/next-runtime.cjs')

async function main() {
  const layout = runtime.resolveRuntimeLayout({ projectRoot: moduleRoot })
  runtime.ensureRuntimeLayout(layout)
  if (!fs.existsSync(layout.pythonPath)) {
    throw new Error(`The isolated qPCR Planner Python environment is missing: ${layout.pythonPath}`)
  }

  const child = spawn(layout.pythonPath, ['-I', layout.backendScript], {
    cwd: modernAppRoot,
    env: runtime.buildBackendEnvironment(process.env, layout, modernAppRoot),
    stdio: 'inherit',
    windowsHide: true,
  })

  const stopChild = (signal) => {
    if (child.exitCode === null && !child.killed) child.kill(signal)
  }
  child.once('exit', (code, signal) => {
    if (!signal) process.exitCode = code === null ? 1 : code
  })
  process.on('SIGINT', () => stopChild('SIGINT'))
  process.on('SIGTERM', () => stopChild('SIGTERM'))

  child.once('error', (error) => {
    console.error(`The qPCR Planner Next API could not start: ${error.message}`)
    process.exitCode = 1
  })
  try {
    await runtime.waitForOwnedHealth(child)
    process.stdout.write(`qPCR Planner Next API ready on 127.0.0.1:${runtime.MODULE.apiPort}\n`)
  } catch (error) {
    stopChild('SIGTERM')
    throw error
  }
}

main().catch((error) => {
  console.error(`The qPCR Planner Next API could not start: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
