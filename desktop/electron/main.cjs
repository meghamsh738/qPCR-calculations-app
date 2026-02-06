const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')

const isDev = !app.isPackaged
const rootDir = path.join(__dirname, '..', '..')
const iconPath = path.join(__dirname, '..', 'build', 'icon.png')
const webDist = path.join(rootDir, '.app-dist', 'web', 'index.html')

const BACKEND_PORT = 8003
const BACKEND_MODULE = 'backend.main:app'

let backendProcess = null

const ensureDirectories = (paths) => {
  const targets = Object.values(paths || {}).filter((val) => typeof val === 'string' && val.trim())
  targets.forEach((target) => fs.mkdirSync(target, { recursive: true }))
}

const getDefaultPaths = () => {
  const base = path.join(app.getPath('documents'), 'Easylab', 'qPCR Planner')
  return {
    dataPath: path.join(base, 'data'),
    attachmentsPath: path.join(base, 'attachments'),
    exportsPath: path.join(base, 'exports'),
    syncPath: path.join(base, 'sync'),
  }
}

const waitForPort = (port, timeoutMs = 8000) => new Promise((resolve, reject) => {
  const start = Date.now()
  const check = () => {
    const socket = net.createConnection({ port }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => {
      socket.destroy()
      if (Date.now() - start > timeoutMs) reject(new Error('timeout'))
      else setTimeout(check, 300)
    })
  }
  check()
})

const resolvePythonCandidates = () => {
  const candidates = []
  if (process.env.APP_PYTHON_PATH) candidates.push(process.env.APP_PYTHON_PATH)
  if (!app.isPackaged) {
    const localVenv = path.join(rootDir, 'modern-app', '.venv', process.platform === 'win32' ? 'Scripts', 'python.exe')
    if (fs.existsSync(localVenv)) candidates.push(localVenv)
  }
  candidates.push('python', 'python3', 'py')
  return Array.from(new Set(candidates))
}

const spawnBackend = async () => {
  if (backendProcess) return
  const backendParent = app.isPackaged
    ? process.resourcesPath
    : path.join(rootDir, 'modern-app')

  const env = {
    ...process.env,
    PYTHONPATH: backendParent,
  }

  const candidates = resolvePythonCandidates()
  for (const candidate of candidates) {
    try {
      const proc = spawn(candidate, ['-m', 'uvicorn', BACKEND_MODULE, '--port', String(BACKEND_PORT)], {
        cwd: backendParent,
        env,
        stdio: 'ignore',
        windowsHide: true,
      })

      const ready = await Promise.race([
        waitForPort(BACKEND_PORT, 6000),
        new Promise((_, reject) => proc.once('error', reject)),
      ])

      if (ready) {
        backendProcess = proc
        proc.on('exit', () => {
          backendProcess = null
        })
        return
      }
    } catch (err) {
      continue
    }
  }

  dialog.showMessageBox({
    type: 'warning',
    title: 'Backend not started',
    message: 'The qPCR backend could not start. Install Python 3.10+ or set APP_PYTHON_PATH, then restart.',
  })
}

const stopBackend = () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    resizable: true,
    backgroundColor: '#0F172A',
    title: app.getName(),
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5176'
    win.loadURL(devUrl)
  } else {
    win.loadFile(webDist)
  }
}

app.whenReady().then(async () => {
  await spawnBackend()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopBackend()
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('select-directory', async (_event, options = {}) => {
  const { title, defaultPath } = options
  const result = await dialog.showOpenDialog({
    title: title || 'Select folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('ensure-directories', async (_event, paths) => {
  try {
    ensureDirectories(paths)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('get-app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
}))

ipcMain.handle('get-default-paths', () => getDefaultPaths())
