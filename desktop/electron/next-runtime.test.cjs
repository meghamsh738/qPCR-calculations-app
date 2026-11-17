const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const test = require('node:test')
const runtime = require('./next-runtime.cjs')

const moduleRoot = path.resolve(__dirname, '..', '..')

function withTemporaryDirectory(run) {
  const root = fs.mkdtempSync(path.join(moduleRoot, '.runtime-isolation-test-'))
  try {
    return run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('runtime paths use shared Next runtime or a namespaced clone fallback', () => {
  withTemporaryDirectory((root) => {
    const workspace = path.join(root, 'easylab-next')
    const source = path.join(workspace, 'modules', 'qpcr-planner')
    const clone = path.join(root, 'qpcr-planner-clone')
    const dev = runtime.resolveRuntimeLayout({ projectRoot: source, env: {} })
    const standalone = runtime.resolveRuntimeLayout({ projectRoot: clone, env: {} })
    const packaged = runtime.resolveRuntimeLayout({
      projectRoot: source,
      isPackaged: true,
      appDataRoot: path.join(root, 'app-data'),
      resourcesPath: path.join(root, 'resources'),
      env: {},
    })

    assert.equal(dev.runtimeRoot, path.join(workspace, 'runtime'))
    assert.equal(dev.pythonEnvRoot, path.join(workspace, 'runtime', 'python-envs', 'qpcr-planner'))
    assert.equal(standalone.runtimeRoot, path.join(clone, '.next-runtime', 'easylab-next'))
    assert.equal(packaged.runtimeRoot, path.join(root, 'app-data', 'EasyLab Next qPCR Planner', 'runtime'))
    assert.equal(packaged.backendScript, path.join(root, 'resources', 'backend', 'run_next.py'))
  })
})

test('runtime setup refuses symlinked Next runtime paths', () => {
  withTemporaryDirectory((root) => {
    const workspace = path.join(root, 'easylab-next')
    const source = path.join(workspace, 'modules', 'qpcr-planner')
    const outside = path.join(root, 'stable-runtime')
    fs.mkdirSync(workspace)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(workspace, 'runtime'), 'dir')
    const layout = runtime.resolveRuntimeLayout({ projectRoot: source, env: {} })
    assert.throws(() => runtime.ensureRuntimeLayout(layout), /Symlink is not allowed/)
  })
})

test('runtime source and stable data overrides fail closed', () => {
  const projectRoot = path.join(moduleRoot, 'runtime-test-project')
  const layout = runtime.resolveRuntimeLayout({ projectRoot, env: {} })
  assert.throws(() => runtime.assertNoSourceOverrides({ APP_DIST_DIR: '/stable/build' }), /APP_DIST_DIR/)
  assert.throws(
    () => runtime.assertPathOverridesMatchLayout({ EASYLAB_EXPORTS_PATH: '/stable/exports' }, layout),
    /EASYLAB_EXPORTS_PATH/,
  )
  assert.throws(
    () => runtime.resolveRuntimeLayout({ projectRoot, env: { EASYLAB_RUNTIME_ROOT: '/stable/runtime' } }),
    /EASYLAB_RUNTIME_ROOT/,
  )
})

test('Vite output validation rejects a redirected build directory', () => {
  withTemporaryDirectory((root) => {
    const project = path.join(root, 'project')
    const outside = path.join(root, 'stable-build')
    fs.mkdirSync(project)
    fs.mkdirSync(outside)
    fs.mkdirSync(path.join(project, '.app-dist'))
    fs.symlinkSync(outside, path.join(project, '.app-dist', 'web'), 'dir')
    assert.throws(
      () => runtime.assertNoSymlinkPathComponents(path.join(project, '.app-dist', 'web')),
      /Symlink is not allowed/,
    )
  })
})

test('only the process that owns a listener can be accepted as the API server', async () => {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  try {
    assert.equal(runtime.assertListenerOwnedBy(port, process.pid), true)
    assert.throws(() => runtime.assertListenerOwnedBy(port, process.pid + 100000), /unknown process/)
    await assert.rejects(runtime.assertPortAvailable(port), /already in use/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('desktop build validation rejects a symlinked .app-dist parent', () => {
  withTemporaryDirectory((root) => {
    const project = path.join(root, 'project')
    const outside = path.join(root, 'stable-checkout')
    fs.mkdirSync(project)
    fs.mkdirSync(path.join(outside, 'web'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'web', 'index.html'), '<!doctype html>')
    fs.symlinkSync(outside, path.join(project, '.app-dist'), 'dir')
    assert.throws(() => runtime.assertLocalWebBuild(project), /Symlink is not allowed/)
  })
})

test('owned API readiness requires the qPCR Planner Next health identity', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', ...runtime.MODULE.health }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  try {
    const health = await runtime.waitForOwnedHealth({ pid: process.pid, exitCode: null }, { port, timeoutMs: 3000 })
    assert.equal(health.app, 'qpcr-planner')
    assert.equal(health.version, 'next')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
