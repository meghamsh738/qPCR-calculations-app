import React, { useEffect, useMemo, useState } from 'react'
import './App.css'

const PLATE_ROWS = 'ABCDEFGHIJKLMNOP'.split('')
const PLATE_COLS = Array.from({ length: 24 }, (_, i) => i + 1)
const CONTROL_COLORS: Record<string, string> = {
  Sample: '#22c55e',
  Standard: '#0ea5e9',
  Positive: '#f59e0b',
  Negative: '#a855f7',
  Blank: '#94a3b8',
  Empty: '#FFF7EC'
}

type GeneEntry = {
  id: number
  name: string
  chemistry: 'SYBR' | 'TaqMan'
  overridePlate?: number | ''
}

type LayoutRow = {
  Plate: string
  Well: string
  Gene: string
  Type: string
  Label: string
  Replicate: number
  Group?: string
   Extras?: string[]
}

type MixRow = {
  Gene: string
  Chemistry: string
  placed_reactions: number
  mix_factor: number
  mix_equiv_rxn: number
  master_mix_2x: number
  rna_free_h2o: number
  probe_10uM: number
  fwd_10uM: number
  rev_10uM: number
}

type SummaryRow = { plate: string; used: number; empty: number }

type PlanResponse = {
  layout: LayoutRow[]
  mix: MixRow[]
  summary: SummaryRow[]
  inputs: Record<string, unknown>
  sample_headers?: string[]
}

type AppPaths = {
  dataPath: string
  attachmentsPath: string
  exportsPath: string
  syncPath: string
}

type ElectronAPI = {
  selectDirectory: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>
  ensureDirectories: (paths: Record<string, string>) => Promise<{ ok: boolean; message?: string }>
  getAppInfo: () => Promise<{ name: string; version: string; platform?: string }>
  getDefaultPaths: () => Promise<AppPaths>
}

const STORAGE_KEY = 'easylab:qpcr-planner:paths'
const resolveApiBase = () => {
  if (typeof window === 'undefined') return undefined
  const params = new URLSearchParams(window.location.search)
  const queryBase = params.get('apiBase') ?? undefined
  const injected = (window as Window & { __EASYLAB_API__?: string }).__EASYLAB_API__
  return injected ?? queryBase
}

const API_BASE = resolveApiBase() ?? import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8003'

const PATH_FIELDS: Array<{ key: keyof AppPaths; label: string; helper: string }> = [
  { key: 'dataPath', label: 'Data folder', helper: 'Saved calculations, cached state, and metadata.' },
  { key: 'attachmentsPath', label: 'Attachments folder', helper: 'Files generated or stored with this workspace.' },
  { key: 'exportsPath', label: 'Exports folder', helper: 'CSV / Excel export destination.' },
  { key: 'syncPath', label: 'Sync folder', helper: 'Optional sync target for backups.' },
]

const fallbackPaths = (): AppPaths => ({
  dataPath: 'Easylab/qPCR Planner/data',
  attachmentsPath: 'Easylab/qPCR Planner/attachments',
  exportsPath: 'Easylab/qPCR Planner/exports',
  syncPath: 'Easylab/qPCR Planner/sync',
})

const readStoredPaths = (): AppPaths | null => {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<AppPaths>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      dataPath: parsed.dataPath ?? '',
      attachmentsPath: parsed.attachmentsPath ?? '',
      exportsPath: parsed.exportsPath ?? '',
      syncPath: parsed.syncPath ?? '',
    }
  } catch {
    return null
  }
}

const persistPaths = (paths: AppPaths) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(paths))
}

const getElectronAPI = (): ElectronAPI | null => {
  if (typeof window === 'undefined') return null
  return (window as typeof window & { electronAPI?: ElectronAPI }).electronAPI ?? null
}

const DEFAULT_GENES: GeneEntry[] = [
  { id: 1, name: 'Tnf', chemistry: 'TaqMan' },
  { id: 2, name: 'Ccl2', chemistry: 'SYBR' },
  { id: 3, name: 'Il1b', chemistry: 'SYBR' },
  { id: 4, name: 'Gapdh', chemistry: 'SYBR' }
]

const DEFAULT_SAMPLE_COUNT = 80
const DEFAULT_SAMPLES = Array.from({ length: DEFAULT_SAMPLE_COUNT }, (_, i) => `Sample${i + 1}`)
const DEFAULT_SAMPLE_TEXT = DEFAULT_SAMPLES.join('\n')

function App() {
  const [storedPaths] = useState(() => readStoredPaths())
  const [paths, setPaths] = useState<AppPaths>(() => storedPaths ?? fallbackPaths())
  const [defaultPaths, setDefaultPaths] = useState<AppPaths>(() => storedPaths ?? fallbackPaths())
  const [setupOpen, setSetupOpen] = useState(() => !storedPaths)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [savingSetup, setSavingSetup] = useState(false)
  const [appInfo, setAppInfo] = useState<{ name: string; version: string } | null>(null)

  const [usePasted, setUsePasted] = useState(true)
  const [sampleText, setSampleText] = useState(DEFAULT_SAMPLE_TEXT)
  const [numSamples, setNumSamples] = useState(DEFAULT_SAMPLE_COUNT)
  const [numStandards, setNumStandards] = useState(8)
  const [numPos, setNumPos] = useState(0)
  const [replicates, setReplicates] = useState(2)
  const [overagePct, setOveragePct] = useState(10)
  const [gapdhSeparate, setGapdhSeparate] = useState(false)
  const [includeRtNeg, setIncludeRtNeg] = useState(true)
  const [includeRnaNeg, setIncludeRnaNeg] = useState(true)
  const [genes, setGenes] = useState<GeneEntry[]>(DEFAULT_GENES)

  const [layout, setLayout] = useState<LayoutRow[]>([])
  const [mix, setMix] = useState<MixRow[]>([])
  const [summary, setSummary] = useState<SummaryRow[]>([])
  const [sampleHeaders, setSampleHeaders] = useState<string[]>([])
  const [plateFilter, setPlateFilter] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const api = getElectronAPI()
    if (!storedPaths && api?.getDefaultPaths) {
      api.getDefaultPaths().then((defaults: AppPaths) => {
        if (!active) return
        setDefaultPaths(defaults)
        setPaths(defaults)
      }).catch(() => {})
    }
    if (api?.getAppInfo) {
      api.getAppInfo().then((info: { name: string; version: string }) => {
        if (!active) return
        setAppInfo(info)
      }).catch(() => {})
    }
    return () => {
      active = false
    }
  }, [storedPaths])

  const updatePath = (key: keyof AppPaths, value: string) => {
    setPaths((prev) => ({ ...prev, [key]: value }))
  }

  const handlePick = async (key: keyof AppPaths, label: string) => {
    const api = getElectronAPI()
    if (!api?.selectDirectory) return
    const selection = await api.selectDirectory({ title: `Select ${label}`, defaultPath: paths[key] })
    if (selection) updatePath(key, selection)
  }

  const handleUseDefaults = () => {
    setPaths(defaultPaths)
    setSetupError(null)
  }

  const ensureDirectories = async (nextPaths: AppPaths) => {
    const api = getElectronAPI()
    if (api?.ensureDirectories) {
      return api.ensureDirectories(nextPaths)
    }
    return { ok: true }
  }

  const handleFinishSetup = async () => {
    setSetupError(null)
    setSavingSetup(true)
    try {
      const trimmed: AppPaths = {
        dataPath: paths.dataPath.trim(),
        attachmentsPath: paths.attachmentsPath.trim(),
        exportsPath: paths.exportsPath.trim(),
        syncPath: paths.syncPath.trim(),
      }
      const missing = Object.entries(trimmed).filter(([, value]) => !value)
      if (missing.length) {
        setSetupError('Please fill all paths before finishing setup.')
        setSavingSetup(false)
        return
      }
      const result = await ensureDirectories(trimmed)
      if (!result?.ok) {
        setSetupError(result?.message || 'Unable to create folders.')
        setSavingSetup(false)
        return
      }
      persistPaths(trimmed)
      setSetupOpen(false)
      setSettingsOpen(false)
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Setup failed.')
    } finally {
      setSavingSetup(false)
    }
  }

  const isDesktop = typeof window !== 'undefined' && !!getElectronAPI()

  useEffect(() => {
    if (!plateFilter && summary.length) {
      setPlateFilter(summary[0].plate)
    }
  }, [summary, plateFilter])

  const plates = useMemo(() => Array.from(new Set(layout.map(l => l.Plate))), [layout])
  const plateSummary = useMemo(() => {
    const chosen = summary.find(s => s.plate === plateFilter)
    if (chosen) return chosen
    return summary[0]
  }, [summary, plateFilter])

  const filteredLayout = useMemo(() => {
    if (!plateFilter) return layout
    return layout.filter(l => l.Plate === plateFilter)
  }, [layout, plateFilter])

  const hasAnyWells = filteredLayout.length > 0

  const schematicCells = useMemo(() => {
    const map = new Map<string, LayoutRow>()
    filteredLayout.forEach(r => map.set(r.Well, r))
    return map
  }, [filteredLayout])

  const MIX_HEADERS = [
    { key: 'Gene', label: 'Gene', align: 'left' },
    { key: 'Chemistry', label: 'Chemistry', align: 'left' },
    { key: 'placed_reactions', label: 'Wells placed', align: 'right' },
    { key: 'mix_factor', label: 'Mix factor (×)', align: 'right' },
    { key: 'mix_equiv_rxn', label: 'Mix eq (µL)', align: 'right' },
    { key: 'master_mix_2x', label: '2X mm (µL)', align: 'right' },
    { key: 'rna_free_h2o', label: 'H2O (µL)', align: 'right' },
    { key: 'probe_10uM', label: 'Probe (µL)', align: 'right' },
    { key: 'fwd_10uM', label: 'Fwd (µL)', align: 'right' },
    { key: 'rev_10uM', label: 'Rev (µL)', align: 'right' }
  ]

  const genePalette = useMemo(() => {
    const genesOrdered = Array.from(new Set(layout.map(l => l.Gene))).sort()
    const palette: Record<string, string> = {}
    genesOrdered.forEach((g, idx) => {
      const hue = (idx * 57) % 360 // spread hues
      palette[g] = `hsl(${hue}deg 75% 55%)`
    })
    return palette
  }, [layout])

  const cellColor = (cell?: LayoutRow | null) => {
    if (!cell) return CONTROL_COLORS.Empty
    if (cell.Type === 'Sample') return genePalette[cell.Gene] || CONTROL_COLORS.Sample
    return CONTROL_COLORS[cell.Type] || CONTROL_COLORS.Sample
  }

  const addGene = () => {
    const nextId = (genes[genes.length - 1]?.id || 0) + 1
    setGenes([...genes, { id: nextId, name: '', chemistry: 'SYBR' }])
  }

  const removeGene = (id: number) => {
    setGenes(genes.filter(g => g.id !== id))
  }

  const updateGene = (id: number, patch: Partial<GeneEntry>) => {
    setGenes(genes.map(g => (g.id === id ? { ...g, ...patch } : g)))
  }

  const handleCalculate = async () => {
    setLoading(true)
    setError(null)
    try {
      const genePayload = genes
        .filter(g => g.name.trim())
        .map(g => ({ name: g.name.trim(), chemistry: g.chemistry }))
      if (!genePayload.length) throw new Error('Please add at least one gene.')

      const overrides: Record<string, number> = {}
      genes.forEach(g => {
        if (g.overridePlate) overrides[g.name.trim()] = Number(g.overridePlate)
      })

      const body = {
        num_samples: numSamples,
        num_standards: numStandards,
        num_pos: numPos,
        replicates,
        overage_pct: overagePct,
        place_gapdh_separate: gapdhSeparate,
        include_rtneg: includeRtNeg,
        include_rnaneg: includeRnaNeg,
        use_pasted_samples: usePasted,
        pasted_samples: usePasted ? sampleText.split('\n') : [],
        genes: genePayload,
        gene_plate_overrides: overrides
      }

      const res = await fetch(`${API_BASE}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        const msg = await res.text()
        throw new Error(msg || 'Plan failed')
      }
      const data: PlanResponse = await res.json()
      setLayout(data.layout)
      setMix(data.mix)
      setSummary(data.summary)
      setSampleHeaders(data.sample_headers || [])
      if (data.summary.length) setPlateFilter(data.summary[0].plate)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to plan layout'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const copyTSV = () => {
    if (!layout.length) return
    const headers = ['Well', 'Gene', 'Type', 'Label', ...sampleHeaders, 'Replicate', 'Plate']
    const lines = [headers.join('\t')]
    layout.forEach(r => {
      const extras = sampleHeaders.map((_, idx) => r.Extras?.[idx] ?? '')
      const row = [
        r.Well,
        r.Gene,
        r.Type,
        r.Label,
        ...extras,
        r.Replicate,
        r.Plate
      ]
      lines.push(row.join('\t'))
    })
    navigator.clipboard.writeText(lines.join('\n'))
    alert('Layout copied to clipboard (TSV).')
  }

  const geneCount = genes.filter(g => g.name.trim()).length

  return (
    <div className="page">
      {setupOpen && (
        <div className="modal-overlay" data-testid="setup-overlay">
          <div className="modal setup-modal">
            <div className="modal-head">
              <div>
                <p className="kicker">First run setup</p>
                <h2>Choose storage folders</h2>
                <p className="muted">
                  These folders keep exports, attachments, and sync data together. You can edit them later in Settings.
                </p>
              </div>
              <span className="pill ghost">Required</span>
            </div>

            <div className="modal-grid">
              {PATH_FIELDS.map((field) => (
                <label key={field.key} className="field path-field">
                  <span className="kicker">{field.label}</span>
                  <div className="field-row">
                    <input
                      value={paths[field.key]}
                      onChange={(event) => updatePath(field.key, event.target.value)}
                      placeholder={defaultPaths[field.key]}
                      data-testid={`path-${field.key}`}
                    />
                    {isDesktop && (
                      <button className="ghost" type="button" onClick={() => handlePick(field.key, field.label)}>
                        Browse
                      </button>
                    )}
                  </div>
                  <span className="muted-small">{field.helper}</span>
                </label>
              ))}
            </div>

            {setupError && <div className="setup-message error" role="alert">{setupError}</div>}
            {!isDesktop && (
              <div className="setup-message">
                Folder creation runs automatically in the desktop app. In the web build, paths are stored for reference.
              </div>
            )}

            <div className="modal-actions">
              <button className="ghost" type="button" onClick={handleUseDefaults}>
                Use defaults
              </button>
              <button className="primary" type="button" onClick={handleFinishSetup} data-testid="setup-finish" disabled={savingSetup}>
                {savingSetup ? 'Saving…' : 'Finish setup'}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-overlay" data-testid="settings-overlay">
          <div className="modal settings-modal">
            <div className="modal-head">
              <div>
                <p className="kicker">Settings</p>
                <h2>Storage paths</h2>
                <p className="muted">Update where this app stores outputs and sync content.</p>
              </div>
              <button className="ghost" type="button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div className="modal-grid">
              {PATH_FIELDS.map((field) => (
                <label key={field.key} className="field path-field">
                  <span className="kicker">{field.label}</span>
                  <div className="field-row">
                    <input
                      value={paths[field.key]}
                      onChange={(event) => updatePath(field.key, event.target.value)}
                      placeholder={defaultPaths[field.key]}
                    />
                    {isDesktop && (
                      <button className="ghost" type="button" onClick={() => handlePick(field.key, field.label)}>
                        Browse
                      </button>
                    )}
                  </div>
                  <span className="muted-small">{field.helper}</span>
                </label>
              ))}
            </div>

            <div className="about-card">
              <div className="section-title">About</div>
              <p className="muted">Easylab qPCR Planner</p>
              <p className="muted-small">Version: {appInfo?.version ?? 'Web build'}</p>
              <p className="muted-small">License: All Rights Reserved.</p>
            </div>

            <div className="modal-actions">
              <button className="ghost" type="button" onClick={handleUseDefaults}>
                Reset to defaults
              </button>
              <button className="primary" type="button" onClick={handleFinishSetup}>
                Save settings
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="hero">
        <div className="hero-text">
          <div className="tag">384-well · QuantStudio 5</div>
          <h1>qPCR plate plans without guesswork</h1>
          <p className="lede">
            Paste samples, list genes with chemistry, set replicates and controls, and get 384-well layouts plus master-mix totals.
            You can pin a gene to its own plate or move it to a later plate.
          </p>
          <div className="pill-row">
            <span className="pill">16 × 24 grid</span>
            <span className="pill">Adjacent replicates</span>
            <span className="pill">Per-gene plate overrides</span>
            <button className="ghost" type="button" onClick={() => setSettingsOpen(true)} data-testid="open-settings">
              Settings
            </button>
          </div>
        </div>
        <div className="hero-meta">
          <p className="kicker">Fixed per run</p>
          <div className="meta-grid">
            <div className="meta-card"><p>Replicates</p><strong>{replicates}×</strong></div>
            <div className="meta-card"><p>Standards</p><strong>{numStandards}</strong></div>
            <div className="meta-card"><p>Pos controls</p><strong>{numPos}</strong></div>
            <div className="meta-card"><p>Overage</p><strong>{overagePct}%</strong></div>
          </div>
          <p className="muted">Each gene starts on its own plate; controls follow samples/standards in-row.</p>
        </div>
      </div>

      {error && (
        <div className="alert error">
          <div><strong>Error:</strong> {error}</div>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="shell grid-2 tall">
        <section className="card" data-testid="samples-card">
          <div className="section-head">
            <div>
              <p className="kicker">Step 1 · Samples</p>
              <h2>Paste list or use count</h2>
              <p className="muted">Headerless list, one per line. Multiple columns ok (tab/comma/space) — first is label, rest show in output.</p>
            </div>
          </div>

          <div className="field big-field">
            <div className="field-top">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={usePasted}
                  onChange={(e) => setUsePasted(e.target.checked)}
                />
                <span className="toggle-ui" />
                <span className="toggle-label">Use pasted samples</span>
              </label>
              {!usePasted && (
                <div className="muted">Count: {numSamples}</div>
              )}
            </div>
            {usePasted ? (
              <textarea
                className="textarea large"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
              />
            ) : (
              <div className="controls">
                <label className="control">
                  <span># Samples</span>
                  <input type="number" value={numSamples} onChange={(e) => setNumSamples(parseInt(e.target.value || '0', 10))} />
                </label>
              </div>
            )}
            <p className="help">Format: label [col2] [col3] … (col2 becomes Group if it is the only extra column).</p>
            <div className="helper">
              <div className="helper-head">
                <div>
                  <p className="kicker">Need to reformat your list?</p>
                  <h3>AI prompt for clean sample labels</h3>
                  <p className="muted">Open a chat, paste this, get back a one-per-line list, then paste it above.</p>
                </div>
                <div className="helper-links">
                  <a href="https://chat.openai.com/" target="_blank" rel="noreferrer">ChatGPT</a>
                  <a href="https://gemini.google.com/app" target="_blank" rel="noreferrer">Gemini</a>
                  <a href="https://grok.com/" target="_blank" rel="noreferrer">Grok</a>
                </div>
              </div>
              <pre className="prompt-block">Convert my table to a plain list of sample labels, one per line, no header. Trim whitespace, keep order, no invented rows. Output text only.</pre>
            </div>
          </div>

        </section>

        <section className="card" data-testid="genes-card">
          <div className="section-head">
            <div>
              <p className="kicker">Step 2 · Genes & controls</p>
              <h2>Chemistry, replicates, controls</h2>
              <p className="muted">Add genes, choose chemistry, and optionally pin a gene to a later plate.</p>
            </div>
          </div>

          <div className="controls">
            <label className="control">
              <span># Standards</span>
              <input type="number" value={numStandards} onChange={(e) => setNumStandards(parseInt(e.target.value || '0', 10))} />
            </label>
            <label className="control">
              <span># Pos controls</span>
              <input type="number" value={numPos} onChange={(e) => setNumPos(parseInt(e.target.value || '0', 10))} />
            </label>
            <label className="control">
              <span>Replicates</span>
              <input type="number" value={replicates} onChange={(e) => setReplicates(parseInt(e.target.value || '1', 10))} />
            </label>
            <label className="control">
              <span>Mix overage (%)</span>
              <input type="number" value={overagePct} onChange={(e) => setOveragePct(parseFloat(e.target.value || '0'))} />
            </label>
          </div>

          <div className="controls">
            <label className="control"><span>GAPDH separate plate</span><input type="checkbox" checked={gapdhSeparate} onChange={(e) => setGapdhSeparate(e.target.checked)} /></label>
            <label className="control"><span>Include RT−</span><input type="checkbox" checked={includeRtNeg} onChange={(e) => setIncludeRtNeg(e.target.checked)} /></label>
            <label className="control"><span>Include RNA−</span><input type="checkbox" checked={includeRnaNeg} onChange={(e) => setIncludeRnaNeg(e.target.checked)} /></label>
          </div>

          <div className="gene-table">
            <div className="gene-header">
              <span>Gene</span><span>Chemistry</span><span>Move to plate #</span><span></span>
            </div>
            {genes.map(g => (
              <div key={g.id} className="gene-row">
                <input
                  className="gene-input"
                  value={g.name}
                  onChange={(e) => updateGene(g.id, { name: e.target.value })}
                  placeholder="Gene name"
                />
                <select
                  value={g.chemistry}
                  onChange={(e) => updateGene(g.id, { chemistry: e.target.value as GeneEntry['chemistry'] })}
                >
                  <option value="SYBR">SYBR</option>
                  <option value="TaqMan">TaqMan</option>
                </select>
                <input
                  className="gene-input"
                  type="number"
                  value={g.overridePlate ?? ''}
                  onChange={(e) => updateGene(g.id, { overridePlate: e.target.value ? parseInt(e.target.value, 10) : '' })}
                  placeholder="e.g., 2"
                />
                <button className="ghost" onClick={() => removeGene(g.id)}>Remove</button>
              </div>
            ))}
            <div className="gene-actions">
              <button className="ghost" onClick={addGene}>+ Add gene</button>
            </div>
          </div>

          <div className="cta-row">
            <div className="muted">Genes: {geneCount} · Replicates: {replicates} · Overages affect mix only.</div>
            <button className="primary" onClick={handleCalculate} disabled={loading} data-testid="calculate-btn">
              {loading ? 'Planning…' : 'Compute layout'}
            </button>
          </div>
        </section>
      </div>

      <div className="shell">
        <section className="card plate-preview-card" data-testid="preview-card">
          <div className="section-head">
            <div>
              <p className="kicker">Preview</p>
              <h2>Plate layout (computed)</h2>
              <p className="muted">Full-width schematic using current inputs.</p>
            </div>
            <div className="muted">
              {plateSummary
                ? `${plateSummary.used} used · ${plateSummary.empty} empty`
                : filteredLayout.length
                  ? `${filteredLayout.length} wells shown`
                  : 'Compute to preview'}
            </div>
          </div>

          <div className="mini-plate">
            <div className="plate-head">
              <div className="plate-head-left">
                <span>Plate preview</span>
                {plates.length > 1 ? (
                  <select
                    className="plate-select"
                    value={plateFilter || plates[0] || ''}
                    onChange={(e) => setPlateFilter(e.target.value)}
                    aria-label="Select plate for preview"
                  >
                    {plates.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <span className="muted-small">({plateFilter || plates[0] || 'Plate 1'})</span>
                )}
              </div>
              {plateSummary && (
                <span className="muted-small">{plateSummary.used}/384 used</span>
              )}
            </div>
            <div className="plate-shell">
              <div className="plate-grid-wrapper">
                <div
                  className="plate-grid"
                  aria-label="plate schematic"
                >
                  <div className="corner" />
                  {PLATE_COLS.map(col => (
                    <div
                      key={`h-${col}`}
                      className="col-head"
                    >
                      {col}
                    </div>
                  ))}
                  {PLATE_ROWS.map((row) => (
                    <React.Fragment key={row}>
                      <div className="row-head">
                        {row}
                      </div>
                      {PLATE_COLS.map((col) => {
                        const well = `${row}${col}`
                        const cell = schematicCells.get(well)
                        const bg = cellColor(cell)
                        return (
                          <div
                            key={well}
                            className="well-square"
                            title={
                              cell
                                ? `${well} • ${cell.Gene} (${cell.Type}${cell.Label ? `: ${cell.Label}` : ''})`
                                : `${well} • Empty`
                            }
                            style={{ backgroundColor: bg }}
                          >
                            {cell && (
                              <span className="well-label">
                                {cell.Label ? cell.Label.slice(0, 4) : cell.Gene.slice(0, 4)}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </React.Fragment>
                  ))}
                </div>
                {!hasAnyWells && (
                  <p className="plate-empty-hint">
                    No layout yet – fill inputs and click <strong>Compute layout</strong>.
                  </p>
                )}
              </div>
            </div>
            <div className="legend">
              <span><span className="swatch sample" /> Sample (per-gene color)</span>
              <span><span className="swatch standard" /> Standard</span>
              <span><span className="swatch positive" /> Positive</span>
              <span><span className="swatch negative" /> RT− / RNA−</span>
              <span><span className="swatch blank" /> Blank</span>
              <span><span className="swatch empty" /> Empty</span>
            </div>
          </div>
        </section>
      </div>

      <div className="shell">
        <div className="tabs">
          <button className="tab active">Output table</button>
        </div>
      </div>

      <div className="shell">
        <section className="card" data-testid="output-card">
          <div className="section-head output-head">
            <div>
              <p className="kicker">Step 3 · Layout</p>
              <h2>Per-plate wells, genes, and controls</h2>
            </div>
            <div className="output-meta">
              <span className="pill ghost">Plates: {plates.length || 0}</span>
              <span className="pill ghost">Genes: {geneCount}</span>
              <span className="pill ghost">Samples: {usePasted ? sampleText.split('\n').filter(Boolean).length : numSamples}</span>
            </div>
            <div className="button-row">
              <select value={plateFilter} onChange={(e) => setPlateFilter(e.target.value)}>
                {plates.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <button className="ghost" onClick={copyTSV} disabled={!layout.length}>Copy TSV</button>
            </div>
          </div>

          {!layout.length && <div className="empty"><p className="muted">No layout yet. Fill inputs and click Compute.</p></div>}

          {layout.length > 0 && (
            <div className="table-wrap">
              <div className="table-scroll">
                <table className="data layout-table">
                  <thead>
                    <tr>
                      {['Well','Gene','Type','Label', ...sampleHeaders, 'Replicate','Plate'].map(h => <th key={h}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLayout.map((row, idx) => (
                      <tr key={idx}>
                        <td>{row.Well}</td>
                        <td>{row.Gene}</td>
                        <td className="type-cell">
                          <span className={`type-dot type-${row.Type.toLowerCase().replace(/[^a-z]/g, '')}`}>●</span>
                          {row.Type}
                        </td>
                        <td>{row.Label}</td>
                        {sampleHeaders.map((h, hIdx) => (
                          <td key={`${idx}-${h}`}>{row.Extras?.[hIdx] ?? ''}</td>
                        ))}
                        <td className="num">{row.Replicate}</td>
                        <td className="plate-cell">{row.Plate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-foot">
                <span>{filteredLayout.length} wells shown</span>
                <span>Plates summary: {summary.map(s => `${s.plate} used ${s.used}/384`).join(' · ')}</span>
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="shell grid-2">
        <section className="card" data-testid="master-card">
          <div className="section-head"><div><p className="kicker">Master mix totals</p><h2>Per gene</h2></div></div>
          {mix.length === 0 && <div className="empty"><p className="muted">Compute to see mix totals.</p></div>}
          {mix.length > 0 && (
            <div className="table-wrap">
              <div className="table-scroll">
                <table className="data mix-table">
                  <thead>
                    <tr>
                      {MIX_HEADERS.map(h => (
                        <th key={h.key} className={h.align === 'right' ? 'num' : ''}>{h.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mix.map((m, idx) => (
                      <tr key={idx}>
                        <td>{m.Gene}</td>
                        <td>{m.Chemistry}</td>
                        <td className="num">{m.placed_reactions}</td>
                        <td className="num">{m.mix_factor.toFixed(2)}</td>
                        <td className="num">{m.mix_equiv_rxn.toFixed(1)}</td>
                        <td className="num">{m.master_mix_2x.toFixed(1)}</td>
                        <td className="num">{m.rna_free_h2o.toFixed(1)}</td>
                        <td className="num">{m.probe_10uM.toFixed(2)}</td>
                        <td className="num">{m.fwd_10uM.toFixed(2)}</td>
                        <td className="num">{m.rev_10uM.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <section className="card notes" data-testid="notes-card">
          <div className="section-head"><div><p className="kicker">Notes & rules</p><h2>How placement works</h2></div></div>
          <ul className="bullets">
            <li>Replicates are adjacent in a row; if the row runs out, placement continues on the next row.</li>
            <li>Each gene uses its own plate; genes never share a plate.</li>
            <li>Order within a gene: Samples → Standards → Positives (if any) → RT− → RNA− → Blank.</li>
            <li>If a gene exceeds 384 wells, reduce inputs or replicates; overrides can skip to a later plate.</li>
            <li>Mix overage increases master-mix volumes only; well counts stay the same.</li>
          </ul>
        </section>
      </div>

      <footer className="signature" data-testid="signature">
        <span className="sig-primary">Made by Meghamsh Teja Konda</span>
        <span className="sig-dot" aria-hidden="true" />
        <a className="sig-link" href="mailto:meghamshteja555@gmail.com">
          meghamshteja555@gmail.com
        </a>
      </footer>
    </div>
  )
}

export default App
