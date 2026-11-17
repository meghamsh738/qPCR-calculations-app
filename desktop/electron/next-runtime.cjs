const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const MODULE = Object.freeze({
  id: 'qpcr-planner',
  storageName: 'qPCR Planner',
  appDataName: 'EasyLab Next qPCR Planner',
  appName: 'EasyLab Next qPCR Planner (Dev)',
  appId: 'com.easylab.qpcrplanner.nextdev',
  packageVersion: '0.3.0-dev.3',
  apiPort: 18512,
  frontendPort: 19512,
  health: Object.freeze({ app: 'qpcr-planner', version: 'next' }),
})

const PATH_ENVIRONMENT = Object.freeze({
  EASYLAB_RUNTIME_ROOT: 'runtimeRoot',
  EASYLAB_DATA_ROOT: 'dataRoot',
  EASYLAB_DATA_PATH: 'dataPath',
  EASYLAB_ATTACHMENTS_PATH: 'attachmentsPath',
  EASYLAB_EXPORTS_PATH: 'exportsPath',
  EASYLAB_SYNC_PATH: 'syncPath',
  EASYLAB_SETTINGS_PATH: 'settingsPath',
})

const SOURCE_OVERRIDE_ENV_KEYS = Object.freeze([
  'APP_DIST_DIR',
  'APP_PYTHON_PATH',
  'EASYLAB_APPS_ROOT',
  'EASYLAB_CDNA_PATH',
  'EASYLAB_QPCR_PLANNER_PATH',
  'EASYLAB_QPCR_ANALYSIS_PATH',
  'EASYLAB_LABNOTE_PATH',
  'EASYLAB_CDNA_DIST_DIR',
  'VITE_DEV_SERVER_URL',
  'VITE_API_BASE',
  'API_BASE_URL',
  'UVICORN_HOST',
  'UVICORN_PORT',
  'HOST',
  'PORT',
])

const SANITIZED_ENV_KEYS = Object.freeze([
  ...SOURCE_OVERRIDE_ENV_KEYS,
  ...Object.keys(PATH_ENVIRONMENT),
  'EASYLAB_MODULE_ID',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONUSERBASE',
  'PYTHONPYCACHEPREFIX',
  'VIRTUAL_ENV',
  'PIP_CONFIG_FILE',
  'PIP_PREFIX',
  'PIP_TARGET',
  'PIP_USER',
  'PIP_CACHE_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'PLAYWRIGHT_OUTPUT_DIR',
])

function isPathInside(parentPath, candidatePath) {
  const parent = path.resolve(parentPath)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isPathInsideOrEqual(parentPath, candidatePath) {
  return path.resolve(parentPath) === path.resolve(candidatePath) || isPathInside(parentPath, candidatePath)
}

function getWorkspaceRoot(projectRoot) {
  const moduleRoot = path.resolve(projectRoot)
  const modulesRoot = path.dirname(moduleRoot)
  const workspaceRoot = path.dirname(modulesRoot)
  if (path.basename(modulesRoot) === 'modules' && path.basename(workspaceRoot) === 'easylab-next') {
    return workspaceRoot
  }
  return null
}

function getDefaultRuntimeRoot({ projectRoot, isPackaged, appDataRoot }) {
  if (isPackaged) {
    if (!appDataRoot || !path.isAbsolute(appDataRoot)) {
      throw new Error('The EasyLab Next app data path must be absolute.')
    }
    return path.join(appDataRoot, MODULE.appDataName, 'runtime')
  }
  const workspaceRoot = getWorkspaceRoot(projectRoot)
  return workspaceRoot
    ? path.join(workspaceRoot, 'runtime')
    : path.join(path.resolve(projectRoot), '.next-runtime', 'easylab-next')
}

function getPythonExecutable(venvRoot, platform = process.platform) {
  return platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python')
}

function resolveRuntimeLayout({ projectRoot, isPackaged = false, appDataRoot, resourcesPath, env = process.env }) {
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    throw new Error('The EasyLab Next module source path must be absolute.')
  }
  const sourceRoot = path.resolve(projectRoot)
  const defaultRuntimeRoot = path.resolve(getDefaultRuntimeRoot({ projectRoot: sourceRoot, isPackaged, appDataRoot }))
  const requestedRuntimeRoot = env.EASYLAB_RUNTIME_ROOT
    ? path.resolve(env.EASYLAB_RUNTIME_ROOT)
    : defaultRuntimeRoot

  if (requestedRuntimeRoot !== defaultRuntimeRoot) {
    throw new Error(`EASYLAB_RUNTIME_ROOT must use this module's isolated Next runtime: ${defaultRuntimeRoot}`)
  }

  const runtimeRoot = defaultRuntimeRoot
  const dataRoot = path.join(runtimeRoot, 'data')
  const moduleDataRoot = path.join(dataRoot, MODULE.storageName)
  const pythonEnvRoot = path.join(runtimeRoot, 'python-envs', MODULE.id)
  const pythonCacheRoot = path.join(runtimeRoot, 'cache', MODULE.id)
  const packagedResourcesRoot = isPackaged
    ? path.resolve(resourcesPath || path.join(sourceRoot, 'resources'))
    : null
  const backendRoot = isPackaged ? packagedResourcesRoot : path.join(sourceRoot, 'modern-app')
  const pythonPath = getPythonExecutable(pythonEnvRoot)

  return Object.freeze({
    module: MODULE,
    projectRoot: sourceRoot,
    workspaceRoot: getWorkspaceRoot(sourceRoot),
    runtimeRoot,
    dataRoot,
    moduleDataRoot,
    dataPath: path.join(moduleDataRoot, 'data'),
    attachmentsPath: path.join(moduleDataRoot, 'attachments'),
    exportsPath: path.join(moduleDataRoot, 'exports'),
    syncPath: path.join(moduleDataRoot, 'sync'),
    settingsPath: path.join(moduleDataRoot, 'settings.json'),
    userDataPath: path.join(runtimeRoot, 'electron-user-data', MODULE.id),
    sessionDataPath: path.join(runtimeRoot, 'electron-session-data', MODULE.id),
    pythonEnvRoot,
    pythonPath,
    pythonEnvParent: path.dirname(pythonEnvRoot),
    pythonCacheRoot,
    pipCachePath: path.join(pythonCacheRoot, 'pip'),
    pycachePath: path.join(pythonCacheRoot, 'bytecode'),
    browserCachePath: path.join(runtimeRoot, 'playwright'),
    browserTestOutputPath: path.join(runtimeRoot, 'browser-tests', MODULE.id),
    backendRoot,
    backendDirectory: backendRoot,
    backendScript: isPackaged
      ? path.join(packagedResourcesRoot, 'backend', 'run_next.py')
      : path.join(sourceRoot, 'modern-app', 'backend', 'run_next.py'),
    webDistPath: path.join(sourceRoot, '.app-dist', 'web', 'index.html'),
    isPackaged,
  })
}

function assertNoSymlinkPathComponents(targetPath, fsImpl = fs) {
  const absolutePath = path.resolve(targetPath)
  const root = path.parse(absolutePath).root
  const components = absolutePath.slice(root.length).split(path.sep).filter(Boolean)
  let currentPath = root

  for (const component of components) {
    currentPath = path.join(currentPath, component)
    let stat
    try {
      stat = fsImpl.lstatSync(currentPath)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in an EasyLab Next path: ${currentPath}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Expected a real directory in an EasyLab Next path: ${currentPath}`)
    }
  }
  return absolutePath
}

function ensureDirectoryTree(targetPath, fsImpl = fs) {
  const absolutePath = path.resolve(targetPath)
  const root = path.parse(absolutePath).root
  const components = absolutePath.slice(root.length).split(path.sep).filter(Boolean)
  let currentPath = root

  for (const component of components) {
    currentPath = path.join(currentPath, component)
    let stat
    try {
      stat = fsImpl.lstatSync(currentPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      try {
        fsImpl.mkdirSync(currentPath, { mode: 0o700 })
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError
      }
      stat = fsImpl.lstatSync(currentPath)
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in an EasyLab Next runtime path: ${currentPath}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Expected a real directory in an EasyLab Next runtime path: ${currentPath}`)
    }
  }
  return absolutePath
}

function ensureRuntimeLayout(layout) {
  for (const directoryPath of [
    layout.runtimeRoot,
    layout.dataRoot,
    layout.moduleDataRoot,
    layout.dataPath,
    layout.attachmentsPath,
    layout.exportsPath,
    layout.syncPath,
    path.dirname(layout.settingsPath),
    layout.userDataPath,
    layout.sessionDataPath,
    layout.pythonCacheRoot,
    layout.pipCachePath,
    layout.pycachePath,
    path.dirname(layout.browserTestOutputPath),
    path.dirname(layout.pythonEnvRoot),
  ]) {
    ensureDirectoryTree(directoryPath)
  }

  if (fs.existsSync(layout.pythonEnvRoot)) {
    const stat = fs.lstatSync(layout.pythonEnvRoot)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`The module Python environment must be a real Next runtime directory: ${layout.pythonEnvRoot}`)
    }
  }
}

function assertPathOverridesMatchLayout(environment, layout) {
  for (const [environmentKey, layoutKey] of Object.entries(PATH_ENVIRONMENT)) {
    const value = environment[environmentKey]
    if (value && path.resolve(value) !== path.resolve(layout[layoutKey])) {
      throw new Error(`${environmentKey} must remain inside this module's Next runtime.`)
    }
  }
  if (environment.EASYLAB_MODULE_ID && environment.EASYLAB_MODULE_ID !== MODULE.id) {
    throw new Error(`EASYLAB_MODULE_ID must be ${MODULE.id}.`)
  }
}

function assertNoSourceOverrides(environment = process.env) {
  const present = SOURCE_OVERRIDE_ENV_KEYS.filter((key) => environment[key] !== undefined && environment[key] !== '')
  if (present.length > 0) {
    throw new Error(`EasyLab Next refuses inherited source, API, or port overrides: ${present.join(', ')}`)
  }
}

function buildBackendEnvironment(sourceEnvironment, layout, backendRoot) {
  assertNoSourceOverrides(sourceEnvironment)
  assertPathOverridesMatchLayout(sourceEnvironment, layout)

  const environment = { ...sourceEnvironment }
  for (const key of SANITIZED_ENV_KEYS) delete environment[key]
  environment.EASYLAB_MODULE_ID = MODULE.id
  environment.EASYLAB_RUNTIME_ROOT = layout.runtimeRoot
  environment.EASYLAB_DATA_ROOT = layout.dataRoot
  environment.EASYLAB_DATA_PATH = layout.dataPath
  environment.EASYLAB_ATTACHMENTS_PATH = layout.attachmentsPath
  environment.EASYLAB_EXPORTS_PATH = layout.exportsPath
  environment.EASYLAB_SYNC_PATH = layout.syncPath
  environment.EASYLAB_SETTINGS_PATH = layout.settingsPath
  environment.PYTHONPATH = backendRoot
  environment.PYTHONPYCACHEPREFIX = layout.pycachePath
  environment.PIP_CACHE_DIR = layout.pipCachePath
  environment.XDG_CACHE_HOME = path.join(layout.pythonCacheRoot, 'xdg')
  return environment
}

function assertLocalWebBuild(projectRoot, fsImpl = fs) {
  const distRoot = path.join(projectRoot, '.app-dist', 'web')
  const indexPath = path.join(distRoot, 'index.html')
  assertNoSymlinkPathComponents(distRoot, fsImpl)
  const distStat = fsImpl.lstatSync(distRoot)
  const indexStat = fsImpl.lstatSync(indexPath)
  if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
    throw new Error(`The Next web build must be a local directory: ${distRoot}`)
  }
  if (indexStat.isSymbolicLink() || !indexStat.isFile()) {
    throw new Error(`The Next web entry must be a local file: ${indexPath}`)
  }
  return indexPath
}

function getListeningPids(port, { platform = process.platform, runCommand = execFileSync } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TCP port: ${port}`)
  }
  let output
  try {
    if (platform === 'win32') {
      const command = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`
      output = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      })
    } else {
      const lsofPath = ['/usr/sbin/lsof', '/usr/bin/lsof', '/usr/local/bin/lsof'].find((candidate) => fs.existsSync(candidate)) || 'lsof'
      output = runCommand(lsofPath, ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8', timeout: 5000,
      })
    }
  } catch (error) {
    if (error.status === 1 && platform !== 'win32') return []
    throw new Error(`Cannot verify the process listening on port ${port}: ${error.message}`)
  }

  return [...new Set(String(output).split(/\s+/).filter(Boolean).map((value) => Number.parseInt(value, 10)))]
    .filter(Number.isInteger)
}

function assertListenerOwnedBy(port, expectedPid, options) {
  const pids = getListeningPids(port, options)
  if (pids.length === 0) return false
  if (pids.length !== 1 || pids[0] !== expectedPid) {
    throw new Error(`Port ${port} is already owned by an unknown process (${pids.join(', ')}).`)
  }
  return true
}

function requestHealth(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          resolve(response.statusCode === 200 ? JSON.parse(body) : null)
        } catch {
          resolve(null)
        }
      })
    })
    request.on('timeout', () => { request.destroy() })
    request.on('error', () => resolve(null))
  })
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForOwnedHealth(child, { port = MODULE.apiPort, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) {
      throw new Error(`The ${MODULE.appName} API process exited before it became ready (code ${child.exitCode}, signal ${child.signalCode}).`)
    }

    const owned = assertListenerOwnedBy(port, child.pid)
    if (owned) {
      const health = await requestHealth(port)
      if (health) {
        for (const [key, value] of Object.entries(MODULE.health)) {
          if (health[key] !== value) {
            throw new Error(`Port ${port} does not serve the expected ${MODULE.id} Next API identity.`)
          }
        }
        return health
      }
    }
    await wait(100)
  }
  throw new Error(`The ${MODULE.appName} API did not start on 127.0.0.1:${port}.`)
}

function assertPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use.`))
      else reject(error)
    })
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => error ? reject(error) : resolve(true))
    })
  })
}

module.exports = {
  MODULE,
  assertListenerOwnedBy,
  assertLocalWebBuild,
  assertNoSourceOverrides,
  assertNoSymlinkPathComponents,
  assertPathOverridesMatchLayout,
  assertPortAvailable,
  buildBackendEnvironment,
  ensureDirectoryTree,
  ensureRuntimeLayout,
  getDefaultRuntimeRoot,
  getListeningPids,
  getPythonExecutable,
  getWorkspaceRoot,
  isPathInside,
  isPathInsideOrEqual,
  resolveRuntimeLayout,
  waitForOwnedHealth,
}
