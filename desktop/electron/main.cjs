const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const runtime = require('./next-runtime.cjs')

const projectRoot = path.resolve(__dirname, '..', '..')
const iconPath = path.join(__dirname, '..', 'build', 'icon.png')
let runtimeLayout = null
let backendProcess = null
const downloadSessions = new WeakSet()

app.setName(runtime.MODULE.appName)
if (process.platform === 'win32') app.setAppUserModelId(runtime.MODULE.appId)

function showStartupError(error) {
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox(`${runtime.MODULE.appName} could not start safely`, message)
  process.exitCode = 1
  app.quit()
}

function getDefaultPaths() {
  return {
    dataPath: runtimeLayout.dataPath,
    attachmentsPath: runtimeLayout.attachmentsPath,
    exportsPath: runtimeLayout.exportsPath,
    syncPath: runtimeLayout.syncPath,
    settingsPath: runtimeLayout.settingsPath,
  }
}

function ensureDirectories(paths) {
  for (const value of Object.values(paths || {})) {
    if (typeof value !== 'string' || !value.trim()) continue
    const target = path.resolve(value)
    if (!runtime.isPathInsideOrEqual(runtimeLayout.runtimeRoot, target)) {
      throw new Error('New directories must stay inside the qPCR Planner Next runtime.')
    }
    runtime.ensureDirectoryTree(target)
  }
}

function chooseDownloadPath(filename) {
  const safeName = path.basename(String(filename || 'download').replace(/[\\/]/g, path.sep))
  const parsed = path.parse(safeName)
  let candidate = path.join(runtimeLayout.exportsPath, safeName)
  let suffix = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(runtimeLayout.exportsPath, `${parsed.name} (${suffix})${parsed.ext}`)
    suffix += 1
  }
  return candidate
}

function stopBackend() {
  if (backendProcess && backendProcess.exitCode === null && !backendProcess.killed) {
    backendProcess.kill('SIGTERM')
  }
  backendProcess = null
}

async function startBackend() {
  runtime.ensureRuntimeLayout(runtimeLayout)
  runtime.assertNoSymlinkPathComponents(runtimeLayout.pythonEnvRoot)
  if (!fs.existsSync(runtimeLayout.pythonPath)) {
    throw new Error(`The isolated qPCR Planner Python environment is missing: ${runtimeLayout.pythonPath}`)
  }

  const environment = runtime.buildBackendEnvironment(
    process.env,
    runtimeLayout,
    runtimeLayout.backendRoot,
  )
  const child = spawn(runtimeLayout.pythonPath, ['-I', runtimeLayout.backendScript], {
    cwd: runtimeLayout.backendDirectory,
    env: environment,
    stdio: 'ignore',
    windowsHide: true,
  })
  backendProcess = child
  child.once('exit', () => {
    if (backendProcess === child) backendProcess = null
  })

  try {
    await Promise.race([
      runtime.waitForOwnedHealth(child),
      new Promise((_, reject) => child.once('error', reject)),
    ])
  } catch (error) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
    if (backendProcess === child) backendProcess = null
    throw error
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    resizable: true,
    backgroundColor: '#0F172A',
    title: runtime.MODULE.appName,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:easylab-next-qpcr-planner',
    },
  })

  if (!downloadSessions.has(win.webContents.session)) {
    downloadSessions.add(win.webContents.session)
    win.webContents.session.on('will-download', (_event, item) => {
      item.setSavePath(chooseDownloadPath(item.getFilename()))
    })
  }
  win.loadFile(runtimeLayout.webDistPath).catch(showStartupError)
  return win
}

try {
  runtime.assertNoSourceOverrides(process.env)
  runtimeLayout = runtime.resolveRuntimeLayout({
    projectRoot,
    isPackaged: app.isPackaged,
    appDataRoot: app.getPath('appData'),
    resourcesPath: process.resourcesPath,
  })
  runtime.assertPathOverridesMatchLayout(process.env, runtimeLayout)
  runtime.ensureRuntimeLayout(runtimeLayout)
  runtimeLayout = Object.freeze({
    ...runtimeLayout,
    webDistPath: runtime.assertLocalWebBuild(projectRoot),
  })
  app.setPath('userData', runtimeLayout.userDataPath)
  app.setPath('sessionData', runtimeLayout.sessionDataPath)
  app.setPath('downloads', runtimeLayout.exportsPath)
} catch (error) {
  showStartupError(error)
  runtimeLayout = null
}

if (runtimeLayout) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.whenReady().then(async () => {
      await startBackend()
      createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    }).catch(showStartupError)
  }
}

app.on('before-quit', stopBackend)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('select-directory', async (_event, options = {}) => {
  const { title, defaultPath } = options
  const result = await dialog.showOpenDialog({
    title: title || 'Select folder',
    defaultPath: defaultPath || runtimeLayout?.exportsPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('ensure-directories', async (_event, paths) => {
  try {
    ensureDirectories(paths)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('get-app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
}))

ipcMain.handle('get-default-paths', () => getDefaultPaths())
