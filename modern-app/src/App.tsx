import React, { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { cdnaSampleLines, readCdnaHandoff, type CdnaHandoff } from './cdnaHandoff'
import { GuidedTutorial, type TutorialStep } from './GuidedTutorial'
import RecipeWorkflow, { type Chemistry, type Recipe, type RecipePreset, type PlannedMix } from './RecipeWorkflow'

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
  SampleIndex?: number
  SampleId?: string
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
  primer_concentration_uM: number
  fwd_primer_ul: number
  rev_primer_ul: number
  recipe_name?: string
  reaction_volume_ul?: number
  sample_volume_ul?: number | null
  water_per_reaction_ul?: number | null
  components?: Array<{ name: string; per_reaction_ul: number; total_ul: number }>
  individual_transfers?: Array<{ name: string; per_well_ul: number; total_ul: number }>
  recipe_issues?: string[]
  dilutions?: PlannedMix['dilutions']
}

type PrimerSource = 'stock' | 'working'

type SummaryRow = { plate: string; used: number; empty: number }

type TemplateBudgetRow = {
  sample_id: string
  label: string
  group: string
  well_count: number
  assays: string[]
  required_ul: number | null
  available_ul: number | null
  status: 'unknown' | 'enough' | 'insufficient' | 'invalid'
  issues: string[]
}

type TemplateBudget = {
  rows: TemplateBudgetRow[]
  issues: string[]
  unknown_count: number
}

type PlanResponse = {
  layout: LayoutRow[]
  mix: MixRow[]
  summary: SummaryRow[]
  template_budget: TemplateBudget
  inputs: Record<string, unknown>
  sample_headers?: string[]
  plate_format?: 96 | 384
  wells_per_plate?: number
}

type PlannerSettings = {
  experimentId: string
  plateFormat: 96 | 384
  numSamples: number
  numStandards: number
  numPos: number
  replicates: number
  overagePct: number
  primerSource: PrimerSource
  gapdhSeparate: boolean
  includeRtNeg: boolean
  includeRnaNeg: boolean
  usePasted: boolean
  sampleText: string
  sampleConcentration: string
  templateAvailableUl: Record<string, string>
  genes: GeneEntry[]
  recipesByChemistry: Record<Chemistry, Recipe>
  layout: LayoutRow[]
  mix: MixRow[]
  summary: SummaryRow[]
  templateBudget?: TemplateBudget | null
  planReviewConfirmed?: boolean
  sampleHeaders: string[]
  plateFilter: string
}

type PlannerPackage = {
  kind: 'easylab-next:qpcr-planner:experiment'
  version: 1
  name: string
  savedAt: string
  planFingerprint: string | null
  settings: PlannerSettings
}

type SavedRecipePreset = { name: string; chemistry: Chemistry; recipe: Recipe }

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
const API_BASE = 'http://127.0.0.1:18512'
const EXPERIMENTS_KEY = 'easylab-next:qpcr-planner:experiments:v1'
const RECIPES_KEY = 'easylab-next:qpcr-planner:recipes:v1'
const PRESETS_KEY = 'easylab-next:qpcr-planner:presets:v1'

const readJson = <T,>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

const isRecipe = (value: unknown): value is Recipe => {
  if (!value || typeof value !== 'object') return false
  const recipe = value as Partial<Recipe>
  return recipe.version === 1 && typeof recipe.name === 'string' && Array.isArray(recipe.components)
}

const parsePlannerPackage = (value: unknown): PlannerPackage => {
  if (!value || typeof value !== 'object') throw new Error('This file is not a qPCR Planner package.')
  const pkg = value as Partial<PlannerPackage>
  if (pkg.kind !== 'easylab-next:qpcr-planner:experiment' || pkg.version !== 1 || !pkg.settings || typeof pkg.settings !== 'object') {
    throw new Error('This package version is not supported by qPCR Planner.')
  }
  if (!isRecipe(pkg.settings.recipesByChemistry?.SYBR) || !isRecipe(pkg.settings.recipesByChemistry?.TaqMan)) {
    throw new Error('The package is missing one or more saved reaction recipes.')
  }
  return pkg as PlannerPackage
}

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

const DEFAULT_SAMPLE_COUNT = 0
const DEFAULT_SAMPLE_TEXT = ''
const createExperimentId = () => `exp-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`

const buildPlanRequest = (settings: PlannerSettings) => {
  const overrides: Record<string, number> = {}
  settings.genes.forEach((gene) => {
    if (gene.overridePlate) overrides[gene.name.trim()] = Number(gene.overridePlate)
  })
  const recipeOverrides = Object.fromEntries((['SYBR', 'TaqMan'] as Chemistry[]).map((chemistry) => [
    chemistry,
    { ...settings.recipesByChemistry[chemistry], overage_pct: settings.overagePct },
  ]))
  return {
    num_samples: settings.numSamples,
    num_standards: settings.numStandards,
    num_pos: settings.numPos,
    replicates: settings.replicates,
    overage_pct: settings.overagePct,
    primer_source: settings.primerSource,
    place_gapdh_separate: settings.gapdhSeparate,
    include_rtneg: settings.includeRtNeg,
    include_rnaneg: settings.includeRnaNeg,
    experiment_id: settings.experimentId,
    use_pasted_samples: settings.usePasted,
    pasted_samples: settings.usePasted ? settings.sampleText.split('\n') : [],
    genes: settings.genes.filter((gene) => gene.name.trim()).map((gene) => ({ name: gene.name.trim(), chemistry: gene.chemistry })),
    gene_plate_overrides: overrides,
    plate_format: settings.plateFormat,
    recipes: recipeOverrides,
    sample_concentration_ng_ul: settings.sampleConcentration ? Number(settings.sampleConcentration) : null,
    template_available_ul: settings.templateAvailableUl ?? {},
  }
}

function App() {
  const [storedPaths] = useState(() => readStoredPaths())
  const [paths, setPaths] = useState<AppPaths>(() => storedPaths ?? fallbackPaths())
  const [defaultPaths, setDefaultPaths] = useState<AppPaths>(() => storedPaths ?? fallbackPaths())
  const [setupOpen, setSetupOpen] = useState(() => !storedPaths && !!getElectronAPI())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [savingSetup, setSavingSetup] = useState(false)
  const [appInfo, setAppInfo] = useState<{ name: string; version: string } | null>(null)

  const [usePasted, setUsePasted] = useState(true)
  const [experimentId, setExperimentId] = useState(createExperimentId)
  const [sampleText, setSampleText] = useState(DEFAULT_SAMPLE_TEXT)
  const [cdnaHandoff, setCdnaHandoff] = useState<CdnaHandoff | null>(null)
  const [cdnaStatus, setCdnaStatus] = useState('')
  const [cdnaInputConfirmed, setCdnaInputConfirmed] = useState(false)
  const cdnaImportSequence = useRef(0)
  const [numSamples, setNumSamples] = useState(DEFAULT_SAMPLE_COUNT)
  const [numStandards, setNumStandards] = useState(8)
  const [numPos, setNumPos] = useState(0)
  const [replicates, setReplicates] = useState(2)
  const [overagePct, setOveragePct] = useState(10)
  const [primerSource, setPrimerSource] = useState<PrimerSource>('working')
  const [gapdhSeparate, setGapdhSeparate] = useState(false)
  const [includeRtNeg, setIncludeRtNeg] = useState(true)
  const [includeRnaNeg, setIncludeRnaNeg] = useState(true)
  const [genes, setGenes] = useState<GeneEntry[]>(DEFAULT_GENES)
  const [plateFormat, setPlateFormat] = useState<96 | 384>(384)
  const [activeView, setActiveView] = useState<'plan' | 'recipe'>('plan')
  const [recipeChemistry, setRecipeChemistry] = useState<Chemistry>('SYBR')
  const [sampleConcentration, setSampleConcentration] = useState('')
  const [templateAvailableUl, setTemplateAvailableUl] = useState<Record<string, string>>({})
  const [presets, setPresets] = useState<RecipePreset[]>([])
  const [recipesByChemistry, setRecipesByChemistry] = useState<Record<Chemistry, Recipe> | null>(() => {
    const saved = readJson<Partial<Record<Chemistry, Recipe>> | null>(RECIPES_KEY, null)
    return saved && isRecipe(saved.SYBR) && isRecipe(saved.TaqMan) ? saved as Record<Chemistry, Recipe> : null
  })
  const recipesAtStartup = useRef(recipesByChemistry)
  const [savedRecipePresets, setSavedRecipePresets] = useState<SavedRecipePreset[]>(() => readJson(PRESETS_KEY, []))
  const [savedExperiments, setSavedExperiments] = useState<PlannerPackage[]>(() => readJson(EXPERIMENTS_KEY, []))
  const [experimentName, setExperimentName] = useState('qPCR plan')
  const [selectedExperiment, setSelectedExperiment] = useState('')
  const [packageStatus, setPackageStatus] = useState('')
  const [lastPlanFingerprint, setLastPlanFingerprint] = useState<string | null>(null)
  const [plannerServiceError, setPlannerServiceError] = useState<string | null>(null)
  const [planReviewConfirmed, setPlanReviewConfirmed] = useState(false)
  const planRequestSequence = useRef(0)

  const [layout, setLayout] = useState<LayoutRow[]>([])
  const [mix, setMix] = useState<MixRow[]>([])
  const [summary, setSummary] = useState<SummaryRow[]>([])
  const [sampleHeaders, setSampleHeaders] = useState<string[]>([])
  const [templateBudget, setTemplateBudget] = useState<TemplateBudget | null>(null)
  const [plateFilter, setPlateFilter] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch(`${API_BASE}/recipes/presets`).then(async (response) => {
      if (!response.ok) throw new Error('Recipe service is unavailable.')
      return response.json()
    }).then((data: { presets?: RecipePreset[] }) => {
      if (!active) return
      const fetchedPresets = Array.isArray(data.presets) ? data.presets : []
      setPresets(fetchedPresets)
      if (!recipesAtStartup.current) {
        const byChemistry = {} as Record<Chemistry, Recipe>
        for (const chemistry of ['SYBR', 'TaqMan'] as Chemistry[]) {
          const preset = fetchedPresets.find((item) => item.chemistry === chemistry && item.primer_source === 'working')
          if (preset) byChemistry[chemistry] = preset.recipe
        }
        if (byChemistry.SYBR && byChemistry.TaqMan) setRecipesByChemistry(byChemistry)
      }
      setPlannerServiceError(null)
    }).catch((fetchError) => {
      if (active) setPlannerServiceError(fetchError instanceof Error ? fetchError.message : 'Recipe service is unavailable.')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (recipesByChemistry && typeof window !== 'undefined') window.localStorage.setItem(RECIPES_KEY, JSON.stringify(recipesByChemistry))
  }, [recipesByChemistry])
  useEffect(() => { if (typeof window !== 'undefined') window.localStorage.setItem(PRESETS_KEY, JSON.stringify(savedRecipePresets)) }, [savedRecipePresets])
  useEffect(() => { if (typeof window !== 'undefined') window.localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify(savedExperiments)) }, [savedExperiments])

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

  const { plateRows, plateCols } = useMemo(() => plateFormat === 96
    ? { plateRows: 'ABCDEFGH'.split(''), plateCols: Array.from({ length: 12 }, (_, index) => index + 1) }
    : { plateRows: 'ABCDEFGHIJKLMNOP'.split(''), plateCols: Array.from({ length: 24 }, (_, index) => index + 1) }, [plateFormat])

  const planRequest = useMemo(() => {
    if (!recipesByChemistry) return null
    return buildPlanRequest({
      experimentId, plateFormat, numSamples, numStandards, numPos, replicates, overagePct, primerSource,
      gapdhSeparate, includeRtNeg, includeRnaNeg, usePasted, sampleText, sampleConcentration,
      templateAvailableUl,
      genes, recipesByChemistry, layout: [], mix: [], summary: [], sampleHeaders: [], plateFilter: '',
    })
  }, [numSamples, numStandards, numPos, replicates, overagePct, primerSource, gapdhSeparate, includeRtNeg, includeRnaNeg, usePasted, sampleText, genes, plateFormat, recipesByChemistry, sampleConcentration, templateAvailableUl, experimentId])
  const currentPlanFingerprint = JSON.stringify(planRequest)
  const planIsStale = lastPlanFingerprint !== currentPlanFingerprint
  const recipePlanIssues = mix.flatMap((row) => (row.recipe_issues ?? []).map((issue) => `${row.Gene}: ${issue}`))
  const templateBudgetIsCurrent = Boolean(templateBudget && !planIsStale)
  const templateBudgetIssues = templateBudgetIsCurrent ? templateBudget?.issues ?? [] : []
  const blockedTemplateRows = templateBudgetIsCurrent ? templateBudget?.rows.filter((row) => row.status === 'insufficient' || row.status === 'invalid') ?? [] : []
  const unknownTemplateRows = templateBudgetIsCurrent ? templateBudget?.rows.filter((row) => row.status === 'unknown') ?? [] : []
  const canReviewTemplateBudget = Boolean(templateBudgetIsCurrent && templateBudgetIssues.length === 0 && blockedTemplateRows.length === 0)
  const canReviewPlan = Boolean(layout.length && !planIsStale && !loading && recipePlanIssues.length === 0 && canReviewTemplateBudget)
  const canFinalizePlan = Boolean(canReviewPlan && planReviewConfirmed)

  useEffect(() => {
    if (planIsStale || loading) setPlanReviewConfirmed(false)
  }, [planIsStale, currentPlanFingerprint, loading])

  useEffect(() => {
    if (!plateFilter && summary.length) {
      setPlateFilter(summary[0].plate)
    }
  }, [summary, plateFilter])

  const plates = useMemo(() => Array.from(new Set(layout.map(l => l.Plate))), [layout])
  const wellsPerPlate = plateRows.length * plateCols.length
  const plateSummary = useMemo(() => {
    const chosen = summary.find(s => s.plate === plateFilter)
    if (chosen) return chosen
    return summary[0]
  }, [summary, plateFilter])

  const filteredLayout = useMemo(() => {
    if (!plateFilter) return layout
    return layout.filter(l => l.Plate === plateFilter)
  }, [layout, plateFilter])

  const tutorialSteps: TutorialStep[] = useMemo(
    () => [
      {
        selector: '[data-testid="samples-mode-toggle"]',
        title: 'Choose sample input mode',
        description: 'Pick whether samples come from a pasted list or a numeric sample count.',
        details: [
          'Use pasted mode when you already have sample IDs.',
          'Use count mode for quick planning before labels are finalized.',
        ],
      },
      {
        selector: '[data-testid="samples-textarea"]',
        title: 'Paste sample list',
        description: 'Provide one sample per line. Extra columns are preserved in output.',
        details: [
          'First token is treated as sample label.',
          'Additional columns are carried as metadata in final layout table.',
        ],
      },
      {
        selector: '[data-testid="standards-input"]',
        title: 'Set controls and replicate count',
        description: 'Configure standards, positives, and replicates before planning.',
        details: [
          'Replicates control how many wells are assigned per sample per gene.',
          'Standards and controls are appended per gene in planned order.',
        ],
      },
      {
        selector: '[data-testid="gapdh-separate-toggle"]',
        title: 'Gene-level options',
        description: 'Use toggles for GAPDH separation and negative-control inclusion.',
        details: [
          'Include RT− and RNA− to reserve wells for negative controls.',
          'Gapdh separate keeps the housekeeping gene in its own chemistry block.',
        ],
      },
      {
        selector: '[data-testid="genes-card"]',
        title: 'Configure gene rows',
        description: 'For each gene set chemistry and optional plate override.',
        details: [
          'SYBR uses primer columns; TaqMan includes probe volume in mix totals.',
          'Plate override forces a gene to start on a chosen plate index.',
        ],
      },
      {
        selector: '[data-testid="calculate-btn"]',
        title: 'Compute layout',
        description: 'Runs placement and mix planning using all current settings.',
        details: [
          'Creates per-well assignment table.',
          'Creates per-gene master-mix totals.',
          'Updates preview and output cards.',
        ],
      },
      {
        selector: '[data-testid="preview-card"]',
        title: 'Validate plate preview',
        description: 'Check occupancy and color-coded well types in the selected plate format.',
        details: [
          'Use plate selector to inspect each generated plate.',
          'Confirm standards/controls are in expected regions.',
        ],
      },
      {
        selector: '[data-testid="output-card"]',
        title: 'Review output table',
        description: 'Inspect the final per-well plan before copy/export.',
        details: [
          'Columns include well, gene, type, label, replicate, and metadata.',
          'Filter by plate to review subsets.',
        ],
      },
      {
        selector: '[data-testid="output-copy-tsv-btn"]',
        title: 'Copy TSV (final step)',
        description: 'Copy layout rows for external spreadsheets or lab documents.',
        details: ['Use after verifying preview and output table.'],
      },
    ],
    []
  )

  const hasAnyWells = filteredLayout.length > 0

  const schematicCells = useMemo(() => {
    const map = new Map<string, LayoutRow>()
    filteredLayout.forEach(r => map.set(r.Well, r))
    return map
  }, [filteredLayout])

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

  const handleSampleTextChange = (value: string) => {
    if (value !== sampleText) {
      setExperimentId(createExperimentId())
      setTemplateAvailableUl({})
      setTemplateBudget(null)
    }
    setSampleText(value)
  }

  const inspectCdnaPackage = async (file: File) => {
    const request = ++cdnaImportSequence.current
    setCdnaHandoff(null)
    setCdnaInputConfirmed(false)
    setCdnaStatus('Checking cDNA package…')
    try {
      const handoff = await readCdnaHandoff(file)
      if (request !== cdnaImportSequence.current) return
      setCdnaHandoff(handoff)
      setCdnaStatus('')
    } catch (error) {
      if (request === cdnaImportSequence.current) {
        setCdnaStatus(error instanceof Error ? error.message : 'Could not open the cDNA package.')
      }
    }
  }

  const useCdnaSamples = () => {
    if (!cdnaHandoff || !cdnaInputConfirmed) return
    planRequestSequence.current += 1
    setLoading(false)
    setUsePasted(true)
    setSampleText(cdnaSampleLines(cdnaHandoff))
    setExperimentId(createExperimentId())
    setTemplateAvailableUl({})
    setSampleConcentration('')
    setTemplateBudget(null)
    setPlanReviewConfirmed(false)
    setLastPlanFingerprint(null)
    setCdnaHandoff(null)
    setCdnaInputConfirmed(false)
    setCdnaStatus(`Samples copied from “${cdnaHandoff.name}”, revision ${cdnaHandoff.revision}. Review the list and calculate a new layout.`)
  }

  const handleSampleCountChange = (value: string) => {
    const nextCount = parseInt(value || '0', 10)
    if (nextCount !== numSamples) {
      setExperimentId(createExperimentId())
      setTemplateAvailableUl({})
      setTemplateBudget(null)
    }
    setNumSamples(nextCount)
  }

  const handleSampleModeChange = (checked: boolean) => {
    if (checked !== usePasted) {
      setExperimentId(createExperimentId())
      setTemplateAvailableUl({})
      setTemplateBudget(null)
    }
    setUsePasted(checked)
  }

  const handleTemplateAvailabilityChange = (sampleId: string, value: string) => {
    setTemplateAvailableUl((previous) => {
      const next = { ...previous }
      if (value === '') delete next[sampleId]
      else next[sampleId] = value
      return next
    })
  }

  const handlePrimerSourceChange = (source: PrimerSource) => {
    setPrimerSource(source)
    setRecipesByChemistry((current) => {
      if (!current) return current
      const stock = source === 'stock' ? 100 : 10
      const next = {} as Record<Chemistry, Recipe>
      for (const chemistry of ['SYBR', 'TaqMan'] as Chemistry[]) {
        const recipe = JSON.parse(JSON.stringify(current[chemistry])) as Recipe
        if (recipe.name.startsWith('Legacy ')) {
          recipe.name = recipe.name.replace(/ · \d+ µM primers$/, '') + ` · ${stock} µM primers`
        }
        recipe.components = recipe.components.map((component) =>
          /^(forward|reverse) primer$/i.test(component.name) && component.mode === 'concentration'
            ? { ...component, stock, stock_unit: 'uM' }
            : component
        )
        next[chemistry] = recipe
      }
      return next
    })
  }

  const handleOverageChange = (value: number) => {
    setOveragePct(value)
    setRecipesByChemistry((current) => current ? {
      SYBR: { ...current.SYBR, overage_pct: value },
      TaqMan: { ...current.TaqMan, overage_pct: value },
    } : current)
  }

  const handleRecipeChange = (chemistry: Chemistry, recipe: Recipe) => {
    setOveragePct(recipe.overage_pct)
    setRecipesByChemistry((current) => current ? {
      SYBR: { ...current.SYBR, overage_pct: recipe.overage_pct },
      TaqMan: { ...current.TaqMan, overage_pct: recipe.overage_pct },
      [chemistry]: recipe,
    } : current)
  }

  const handleCalculate = async () => {
    const request = planRequest
    if (!request) {
      setError('The isolated recipe service has not loaded yet.')
      return
    }
    setLoading(true)
    setPlanReviewConfirmed(false)
    setError(null)
    const requestId = ++planRequestSequence.current
    const requestFingerprint = JSON.stringify(request)
    try {
      if (!request.genes.length) throw new Error('Please add at least one gene.')

      const res = await fetch(`${API_BASE}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
      if (!res.ok) {
        const msg = await res.text()
        throw new Error(msg || 'Plan failed')
      }
      const data: PlanResponse = await res.json()
      if (requestId !== planRequestSequence.current) return
      setLayout(data.layout)
      setMix(data.mix)
      setSummary(data.summary)
      setSampleHeaders(data.sample_headers || [])
      setTemplateBudget(data.template_budget)
      setLastPlanFingerprint(requestFingerprint)
      if (data.summary.length) setPlateFilter(data.summary[0].plate)
    } catch (err) {
      if (requestId === planRequestSequence.current) {
        const message = err instanceof Error ? err.message : 'Failed to plan layout'
        setError(message)
      }
    } finally {
      if (requestId === planRequestSequence.current) setLoading(false)
    }
  }

  const copyTSV = async () => {
    if (!canFinalizePlan) return
    const headers = ['Well', 'Gene', 'Type', 'Label', 'Sample #', 'Sample ID', ...sampleHeaders, 'Replicate', 'Plate']
    const lines = [headers.join('\t')]
    layout.forEach(r => {
      const extras = sampleHeaders.map((_, idx) => r.Extras?.[idx] ?? '')
      const row = [
        r.Well,
        r.Gene,
        r.Type,
        r.Label,
        r.SampleIndex ?? '',
        r.SampleId ?? '',
        ...extras,
        r.Replicate,
        r.Plate
      ]
      lines.push(row.join('\t'))
    })
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setError(null)
      alert('Layout copied to clipboard (TSV).')
    } catch {
      setError('Could not copy the layout. Allow clipboard access and try again.')
    }
  }

  const mixExportRows = () => {
    const headers = ['Gene', 'Recipe', 'Wells', 'Component', 'Preparation type', 'Per reaction/well (µL)', 'Preparation total (µL)', 'Overage included']
    const rows = mix.flatMap((row) => [
      ...(row.components ?? []).map((component) => [row.Gene, row.recipe_name ?? '', row.placed_reactions, component.name, 'Pooled master mix', component.per_reaction_ul, component.total_ul, 'Yes']),
      ...(row.individual_transfers ?? []).map((component) => [row.Gene, row.recipe_name ?? '', row.placed_reactions, component.name, 'Individual well transfers', component.per_well_ul, component.total_ul, 'No']),
    ])
    return [headers, ...rows]
  }

  const copyMixTSV = async () => {
    if (!canFinalizePlan) return
    const lines = mixExportRows().map((row) => row.map((value) => String(value ?? '').replace(/[\t\r\n]/g, ' ')).join('\t'))
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setError(null)
      alert('Mix preparation table copied (TSV).')
    } catch {
      setError('Could not copy the mix table. Allow clipboard access and try again.')
    }
  }

  const exportMixCsv = () => {
    if (!canFinalizePlan) return
    const csv = mixExportRows().map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${experimentName.replace(/[^a-z0-9_-]+/gi, '_') || 'qpcr-plan'}-mix-preparation.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const currentPackage = (name: string): PlannerPackage | null => {
    if (!recipesByChemistry) return null
    const settings: PlannerSettings = {
      experimentId,
      plateFormat, numSamples, numStandards, numPos, replicates, overagePct, primerSource,
      gapdhSeparate, includeRtNeg, includeRnaNeg, usePasted, sampleText, sampleConcentration,
      templateAvailableUl: { ...templateAvailableUl },
      genes: JSON.parse(JSON.stringify(genes)) as GeneEntry[],
      recipesByChemistry: JSON.parse(JSON.stringify(recipesByChemistry)) as Record<Chemistry, Recipe>,
      layout: JSON.parse(JSON.stringify(layout)) as LayoutRow[],
      mix: JSON.parse(JSON.stringify(mix)) as MixRow[],
      summary: JSON.parse(JSON.stringify(summary)) as SummaryRow[],
      templateBudget: templateBudget ? JSON.parse(JSON.stringify(templateBudget)) as TemplateBudget : null,
      planReviewConfirmed,
      sampleHeaders: [...sampleHeaders], plateFilter,
    }
    return {
      kind: 'easylab-next:qpcr-planner:experiment',
      version: 1,
      name: name.trim() || 'qPCR plan',
      savedAt: new Date().toISOString(),
      planFingerprint: lastPlanFingerprint,
      settings,
    }
  }

  const restorePackage = (pkg: PlannerPackage) => {
    cdnaImportSequence.current += 1
    setCdnaHandoff(null)
    setCdnaStatus('')
    setCdnaInputConfirmed(false)
    const settings = {
      ...pkg.settings,
      experimentId: pkg.settings.experimentId || createExperimentId(),
      templateAvailableUl: pkg.settings.templateAvailableUl ?? {},
      templateBudget: pkg.settings.templateBudget ?? null,
      planReviewConfirmed: pkg.settings.planReviewConfirmed === true,
    }
    const request = buildPlanRequest(settings)
    const requestFingerprint = JSON.stringify(request)
    const requestId = ++planRequestSequence.current
    setLoading(true)
    setPlanReviewConfirmed(false)
    setExperimentId(settings.experimentId)
    setPlateFormat(settings.plateFormat === 96 ? 96 : 384)
    setNumSamples(settings.numSamples)
    setNumStandards(settings.numStandards)
    setNumPos(settings.numPos)
    setReplicates(settings.replicates)
    setOveragePct(settings.overagePct)
    setPrimerSource(settings.primerSource)
    setGapdhSeparate(settings.gapdhSeparate)
    setIncludeRtNeg(settings.includeRtNeg)
    setIncludeRnaNeg(settings.includeRnaNeg)
    setUsePasted(settings.usePasted)
    setSampleText(settings.sampleText)
    setSampleConcentration(settings.sampleConcentration ?? '')
    setTemplateAvailableUl(settings.templateAvailableUl)
    setGenes(settings.genes)
    setRecipesByChemistry(settings.recipesByChemistry)
    setLayout([])
    setMix([])
    setSummary([])
    setSampleHeaders([])
    setTemplateBudget(null)
    setPlateFilter(settings.plateFilter ?? '')
    setExperimentName(pkg.name)
    setLastPlanFingerprint(null)
    setActiveView('plan')
    setError(null)
    setPackageStatus(`Opened “${pkg.name}”; recalculating the saved inputs.`)
    fetch(`${API_BASE}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.text()) || 'Saved inputs could not be recalculated.')
      return response.json() as Promise<PlanResponse>
    }).then((data) => {
      if (requestId !== planRequestSequence.current) return
      setLayout(data.layout)
      setMix(data.mix)
      setSummary(data.summary)
      setSampleHeaders(data.sample_headers || [])
      setTemplateBudget(data.template_budget)
      setLastPlanFingerprint(requestFingerprint)
      const packageReviewMatches = settings.planReviewConfirmed === true
        && pkg.planFingerprint === requestFingerprint
        && JSON.stringify(settings.layout ?? []) === JSON.stringify(data.layout)
        && JSON.stringify(settings.mix ?? []) === JSON.stringify(data.mix)
        && JSON.stringify(settings.summary ?? []) === JSON.stringify(data.summary)
        && JSON.stringify(settings.sampleHeaders ?? []) === JSON.stringify(data.sample_headers || [])
        && JSON.stringify(settings.templateBudget ?? null) === JSON.stringify(data.template_budget)
      setPlanReviewConfirmed(packageReviewMatches)
      if (data.summary.length) setPlateFilter(data.summary[0].plate)
      setPackageStatus(`Opened “${pkg.name}” and recalculated its layout from the saved inputs.`)
    }).catch((restoreError) => {
      if (requestId !== planRequestSequence.current) return
      setPackageStatus(`Opened the inputs, but could not recalculate this layout: ${restoreError instanceof Error ? restoreError.message : 'planner service error'}. Compute the plan again.`)
    }).finally(() => {
      if (requestId === planRequestSequence.current) setLoading(false)
    })
  }

  const saveLocalPackage = () => {
    const pkg = currentPackage(experimentName)
    if (!pkg) {
      setPackageStatus('Wait for the isolated planner service to load recipes, then save again.')
      return
    }
    setSavedExperiments((previous) => [pkg, ...previous.filter((item) => item.name !== pkg.name)].slice(0, 30))
    setSelectedExperiment(pkg.name)
    setPackageStatus(`Saved “${pkg.name}” on this device.`)
  }

  const exportPackage = () => {
    const pkg = currentPackage(experimentName)
    if (!pkg) {
      setPackageStatus('Wait for recipes to load before exporting this package.')
      return
    }
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${pkg.name.replace(/[^a-z0-9_-]+/gi, '_') || 'qpcr-plan'}.qpcr-planner.json`
    link.click()
    URL.revokeObjectURL(url)
    setPackageStatus('Exported a versioned qPCR Planner package.')
  }

  const importPackageFile = (file?: File) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const pkg = parsePlannerPackage(JSON.parse(String(reader.result)))
        restorePackage(pkg)
        setSavedExperiments((previous) => [pkg, ...previous.filter((item) => item.name !== pkg.name)].slice(0, 30))
        setSelectedExperiment(pkg.name)
      } catch (importError) {
        setPackageStatus(importError instanceof Error ? importError.message : 'Could not open this package.')
      }
    }
    reader.onerror = () => setPackageStatus('Could not read the selected package file.')
    reader.readAsText(file)
  }

  const startNewExperiment = () => {
    cdnaImportSequence.current += 1
    setCdnaHandoff(null)
    setCdnaStatus('')
    setCdnaInputConfirmed(false)
    planRequestSequence.current += 1
    setLoading(false)
    setPlanReviewConfirmed(false)
    setUsePasted(true)
    setExperimentId(createExperimentId())
    setSampleText('')
    setSampleConcentration('')
    setTemplateAvailableUl({})
    setNumSamples(0)
    setNumStandards(0)
    setNumPos(0)
    setReplicates(2)
    setGapdhSeparate(false)
    setIncludeRtNeg(false)
    setIncludeRnaNeg(false)
    setGenes([{ id: 1, name: '', chemistry: 'SYBR' }])
    setLayout([])
    setMix([])
    setSummary([])
    setSampleHeaders([])
    setTemplateBudget(null)
    setPlateFilter('')
    setLastPlanFingerprint(null)
    setExperimentName('New qPCR plan')
    setSelectedExperiment('')
    setPackageStatus('Started a blank plan. Recipes and plate format were retained.')
    setActiveView('plan')
  }

  const exportAnalysisHandoff = () => {
    if (!canFinalizePlan) return
    const headers = ['Well', 'Gene', 'Label', 'Cq', 'Plate', 'SampleId', 'Group', 'Type', 'Replicate']
    const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const rows = layout.map((row) => [row.Well, row.Gene, row.Label, '', row.Plate, row.SampleId ?? '', row.Group ?? '', row.Type, row.Replicate])
    const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n')
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${experimentName.replace(/[^a-z0-9_-]+/gi, '_') || 'qpcr-plan'}-analysis-handoff.csv`
    link.click()
    URL.revokeObjectURL(url)
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
          <div className="tag">{plateFormat}-well · QuantStudio 5</div>
          <h1>qPCR plate plans without guesswork</h1>
          <p className="lede">
            Paste samples, list genes with chemistry, set replicates and controls, and get plate layouts plus master-mix totals.
            You can assign a gene to a specific plate or move it later.
          </p>
          <div className="pill-row">
            <span className="pill">{plateFormat === 96 ? '8 × 12' : '16 × 24'} grid</span>
            <span className="pill">Adjacent replicates</span>
            <span className="pill">Per-gene plate overrides</span>
            {isDesktop && <button className="ghost" type="button" onClick={() => setSettingsOpen(true)} data-testid="open-settings">Storage settings</button>}
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
          <p className="muted">Same-chemistry genes pack together when they fit. SYBR and TaqMan use separate plates; each gene block starts at column 1.</p>
        </div>
      </div>

      <div className="shell">
        <div className="tabs primary-workflow-tabs" aria-label="Planner workflow">
          <button className={`tab ${activeView === 'plan' ? 'active' : ''}`} type="button" aria-pressed={activeView === 'plan'} onClick={() => setActiveView('plan')}>Plate layout</button>
          <button className={`tab ${activeView === 'recipe' ? 'active' : ''}`} type="button" aria-pressed={activeView === 'recipe'} onClick={() => setActiveView('recipe')} data-testid="recipe-tab">Reaction recipe</button>
        </div>
      </div>

      <div className="shell">
        <details className="package-details">
          <summary>Saved experiments and packages</summary>
          <div className="package-panel">
            <label className="field"><span className="kicker">Experiment name</span><input value={experimentName} onChange={(event) => setExperimentName(event.target.value)} data-testid="package-name" /></label>
            <div className="package-actions">
              <button className="primary" type="button" onClick={saveLocalPackage} data-testid="save-local-package">Save on this device</button>
              <button className="ghost" type="button" onClick={exportPackage} data-testid="export-package">Export package</button>
              <label className="ghost file-pick-button">Open package file<input type="file" accept="application/json,.json" onChange={(event) => { importPackageFile(event.target.files?.[0]); event.currentTarget.value = '' }} data-testid="import-package" /></label>
              <button className="ghost" type="button" onClick={startNewExperiment} data-testid="new-experiment">New experiment</button>
            </div>
            <div className="package-open-row">
              <label className="field"><span className="kicker">Saved on this device</span><select aria-label="Saved local package" value={selectedExperiment} onChange={(event) => setSelectedExperiment(event.target.value)}>
                <option value="">Choose a saved experiment…</option>
                {savedExperiments.map((item) => <option key={`${item.name}-${item.savedAt}`} value={item.name}>{item.name} · {new Date(item.savedAt).toLocaleString()}</option>)}
              </select></label>
              <button className="ghost" type="button" disabled={!selectedExperiment} onClick={() => {
                const pkg = savedExperiments.find((item) => item.name === selectedExperiment)
                if (pkg) restorePackage(pkg)
              }} data-testid="open-local-package">Open saved experiment</button>
            </div>
            {packageStatus && <p className="status-note" role="status">{packageStatus}</p>}
            <p className="muted-small">Saved packages and named presets stay in this browser’s local storage or this desktop app profile. Exported packages and CSVs use the browser or operating system download location. Recipe and display settings carry into a new experiment; the sample list and calculated layout are cleared.</p>
          </div>
        </details>
      </div>

      {plannerServiceError && <div className="shell"><div className="alert error" role="alert">{plannerServiceError} Start the isolated qPCR Planner service on port 18512.</div></div>}

      {error && (
        <div className="alert error">
          <div><strong>Error:</strong> {error}</div>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {activeView === 'plan' && planIsStale && layout.length > 0 && (
        <div className="shell"><p className="warning-note" role="status">Plan inputs changed after this layout was calculated. Recompute before copying or handing it to qPCR Analysis.</p></div>
      )}

      {activeView === 'plan' && <>

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
                  onChange={(e) => handleSampleModeChange(e.target.checked)}
                  data-testid="samples-mode-toggle"
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
                onChange={(e) => handleSampleTextChange(e.target.value)}
                data-testid="samples-textarea"
              />
            ) : (
              <div className="controls">
                <label className="control">
                  <span># Samples</span>
                  <input type="number" value={numSamples} onChange={(e) => handleSampleCountChange(e.target.value)} />
                </label>
              </div>
            )}
            <details className="package-details">
              <summary>Import samples from cDNA Calculator</summary>
              <div className="package-panel">
                <p className="help">Open a reviewed cDNA experiment package. You can check its samples before replacing this list.</p>
                <label className="ghost file-pick-button">Choose cDNA package
                  <input type="file" accept=".json,application/json" aria-label="Choose cDNA package" onChange={event => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (file) void inspectCdnaPackage(file)
                  }} />
                </label>
                {cdnaStatus && <p role="status">{cdnaStatus}</p>}
                {cdnaHandoff && <>
                  <h3>{cdnaHandoff.name} · revision {cdnaHandoff.revision}</h3>
                  <p>{cdnaHandoff.samples.filter(sample => sample.ready).length} ready of {cdnaHandoff.samples.length} source rows</p>
                  <ul>
                    {cdnaHandoff.samples.map((sample, index) => <li key={`${sample.sourceRow}-${index}`}>
                      {sample.label || 'Unnamed sample'} · row {sample.sourceRow} · {sample.ready ? 'Ready' : sample.reason || 'Not ready'}
                    </li>)}
                  </ul>
                  <p className="help">Only sample labels are carried forward. Set the measured template concentration separately if the qPCR recipe uses mass-based input.</p>
                  {recipesByChemistry && <p className="help">
                    Current input per reaction: {(['SYBR', 'TaqMan'] as const).map(chemistry => {
                      const input = recipesByChemistry[chemistry].sample_input
                      return `${chemistry} ${input.value} ${input.unit === 'uL' ? 'µL' : input.unit}`
                    }).join(' · ')}
                  </p>}
                  <label><input type="checkbox" checked={cdnaInputConfirmed} onChange={event => setCdnaInputConfirmed(event.target.checked)} /> I checked the qPCR recipe input per reaction</label>
                  <button className="primary" type="button" disabled={!cdnaInputConfirmed || !recipesByChemistry} onClick={useCdnaSamples}>Replace list with ready samples</button>
                </>}
              </div>
            </details>
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
              <input
                type="number"
                value={numStandards}
                onChange={(e) => setNumStandards(parseInt(e.target.value || '0', 10))}
                data-testid="standards-input"
              />
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
              <input type="number" value={overagePct} onChange={(e) => handleOverageChange(parseFloat(e.target.value || '0'))} />
            </label>
          <label className="control">
            <span>Plate format</span>
            <select value={plateFormat} onChange={(e) => setPlateFormat(Number(e.target.value) as 96 | 384)} data-testid="plate-format-select">
              <option value={96}>96-well</option>
              <option value={384}>384-well</option>
            </select>
          </label>
            <label className="control">
              <span>Primer solution</span>
              <select
                value={primerSource}
                onChange={(e) => handlePrimerSourceChange(e.target.value as PrimerSource)}
                data-testid="primer-source-select"
              >
                <option value="working">Working (10 µM)</option>
                <option value="stock">Stock (100 µM)</option>
              </select>
            </label>
          </div>

          <div className="controls">
            <label className="control">
              <span>GAPDH separate plate</span>
              <input
                type="checkbox"
                checked={gapdhSeparate}
                onChange={(e) => setGapdhSeparate(e.target.checked)}
                data-testid="gapdh-separate-toggle"
              />
            </label>
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
            <button className="primary" onClick={handleCalculate} disabled={loading || !recipesByChemistry} data-testid="calculate-btn">
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
              <span className="muted-small">{plateSummary.used}/{wellsPerPlate} used</span>
              )}
            </div>
            <div className="plate-shell">
              <div className="plate-grid-wrapper">
                <div
                  className="plate-grid"
                  aria-label="plate schematic"
                  style={{
                    gridTemplateColumns: `46px repeat(${plateCols.length}, minmax(12px, 1fr))`,
                    gridTemplateRows: `40px repeat(${plateRows.length}, minmax(12px, auto))`,
                  }}
                >
                  <div className="corner" />
                  {plateCols.map(col => (
                    <div
                      key={`h-${col}`}
                      className="col-head"
                    >
                      {col}
                    </div>
                  ))}
                  {plateRows.map((row) => (
                    <React.Fragment key={row}>
                      <div className="row-head">
                        {row}
                      </div>
                      {plateCols.map((col) => {
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
              <span><span className="swatch empty-well" /> Empty</span>
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
              <GuidedTutorial
                steps={tutorialSteps}
                startLabel="Tutorial"
              />
              <select value={plateFilter} onChange={(e) => setPlateFilter(e.target.value)}>
                {plates.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <button className="ghost" onClick={exportAnalysisHandoff} disabled={!canFinalizePlan} title={canFinalizePlan ? undefined : 'Resolve recipe issues, recompute, and confirm you reviewed the plan.'} data-testid="analysis-handoff-btn">Export qPCR Analysis handoff</button>
              <button className="ghost" onClick={copyTSV} disabled={!canFinalizePlan} title={canFinalizePlan ? undefined : 'Resolve recipe issues, recompute, and confirm you reviewed the plan.'} data-testid="output-copy-tsv-btn">Copy TSV</button>
            </div>
            <p className="muted-small handoff-instructions">For qPCR Analysis, load the handoff CSV as sample information and match instrument wells by <strong>Plate and Well</strong>. The Cq column is intentionally blank for Analysis to fill from the instrument file.</p>
          </div>

          {layout.length > 0 && (
            <section className="template-budget" data-testid="template-budget">
              <div className="section-head">
                <div>
                  <p className="kicker">Template stock check</p>
                  <h2>Required volume by sample</h2>
                </div>
              </div>
              <p className="muted-small">
                Required volume sums sample input across this plan’s biological sample wells. It excludes extra handling loss and master-mix overage; control stocks are reviewed separately. Unknown availability stays unknown until you confirm stock during final review.
              </p>
              {planIsStale && <p className="warning-note" role="status">The plan or availability values changed. Recompute to refresh these totals and statuses.</p>}
              {templateBudget?.rows.length ? (
                <div className="table-wrap">
                  <div className="table-scroll">
                    <table className="data template-budget-table">
                      <thead><tr><th>Sample</th><th>Group</th><th>Sample ID</th><th>Assays</th><th className="num">Wells</th><th className="num">Required (µL)</th><th>Available (µL)</th><th>Status</th></tr></thead>
                      <tbody>
                        {templateBudget.rows.map((row) => (
                          <tr key={row.sample_id} data-testid="template-budget-row">
                            <td>{row.label}</td>
                            <td>{row.group || '—'}</td>
                            <td className="sample-id-cell" data-testid="sample-identity">{row.sample_id}</td>
                            <td>{planIsStale ? '—' : row.assays.join(', ') || '—'}</td>
                            <td className="num">{planIsStale ? '—' : row.well_count}</td>
                            <td className="num">{planIsStale ? 'Recalculate' : row.required_ul === null ? '—' : row.required_ul.toFixed(3)}</td>
                            <td>
                              <input
                                className="template-availability-input"
                                type="text"
                                inputMode="decimal"
                                aria-label={`Available template volume in µL for ${row.label} (${row.sample_id})`}
                                value={templateAvailableUl[row.sample_id] ?? ''}
                                onChange={(event) => handleTemplateAvailabilityChange(row.sample_id, event.target.value)}
                                data-testid="template-available-volume"
                              />
                            </td>
                            <td><span className={`template-budget-status status-${planIsStale ? 'stale' : row.status}`}>{planIsStale ? 'Recalculate' : row.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="muted-small" data-testid="template-budget-empty">{templateBudget ? 'This plan has no biological sample wells to assess.' : 'Recompute the plan to assess sample template requirements.'}</p>
              )}
              {(templateBudgetIssues.length > 0 || blockedTemplateRows.length > 0) && (
                <div className="warning-note" data-testid="template-budget-block">
                  Known insufficient or invalid template availability must be corrected before final export.
                  <ul>
                    {templateBudgetIssues.map((issue, index) => <li key={`budget-issue-${index}`}>{issue}</li>)}
                    {blockedTemplateRows.flatMap((row) => row.issues.map((issue, index) => <li key={`${row.sample_id}-issue-${index}`}>{row.label}: {issue}</li>))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {layout.length > 0 && (
            <div className="plan-review-gate" data-testid="plan-review-gate">
              <label className="toggle plan-review-confirmation">
                <input
                  type="checkbox"
                  checked={planReviewConfirmed}
                  disabled={!canReviewPlan}
                  onChange={(event) => setPlanReviewConfirmed(event.target.checked)}
                  data-testid="plan-review-confirmation"
                />
                <span className="toggle-ui" />
                <span className="toggle-label">I reviewed sample IDs, recipe and plate layout, and confirmed enough final template stock for every sample.</span>
              </label>
              {unknownTemplateRows.length > 0 && (
                <p className="muted-small" data-testid="unknown-template-confirmation-note">
                  {unknownTemplateRows.length} sample{unknownTemplateRows.length === 1 ? '' : 's'} have Unknown availability. Checking the review box confirms enough stock is available for each Unknown sample.
                </p>
              )}
              {recipePlanIssues.length > 0 && (
                <div className="warning-note" data-testid="recipe-finalization-block">
                  This layout is a preview. Resolve the recipe or transfer issues, then compute again before copying or handing off the plan.
                  <ul>{recipePlanIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
                </div>
              )}
              {(templateBudgetIssues.length > 0 || blockedTemplateRows.length > 0) && (
                <div className="warning-note" data-testid="template-finalization-block">
                  Resolve each known template shortage or invalid availability value, then recompute before copying or handing off the plan.
                  <ul>
                    {templateBudgetIssues.map((issue, index) => <li key={`final-budget-issue-${index}`}>{issue}</li>)}
                    {blockedTemplateRows.flatMap((row) => row.issues.map((issue, index) => <li key={`${row.sample_id}-final-issue-${index}`}>{row.label}: {issue}</li>))}
                  </ul>
                </div>
              )}
              {planReviewConfirmed && !canReviewPlan && <p className="muted-small">Review confirmation cleared because the plan inputs or recipe checks changed.</p>}
              {loading && <p className="muted-small" role="status">Recalculating this plan; review confirmation is cleared.</p>}
            </div>
          )}

          {!layout.length && <div className="empty"><p className="muted">No layout yet. Fill inputs and click Compute.</p></div>}

          {layout.length > 0 && (
            <div className="table-wrap">
              <div className="table-scroll">
                <table className="data layout-table">
                  <thead>
                    <tr>
                      {['Well','Gene','Type','Label','Sample #','Sample ID', ...sampleHeaders, 'Replicate','Plate'].map(h => <th key={h} scope="col" title={h === 'Sample #' ? 'Position in the input sample list. Repeated labels keep separate numbers.' : h === 'Sample ID' ? 'Stable ID shared across genes and plates for one input occurrence.' : undefined}>{h}</th>)}
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
                        <td className="num">{row.SampleIndex ?? ''}</td>
                        <td data-testid="sample-identity">{row.SampleId ?? ''}</td>
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
                <span>Plates summary: {summary.map(s => `${s.plate} used ${s.used}/${wellsPerPlate}`).join(' · ')}</span>
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="shell grid-2">
        <section className="card" data-testid="master-card">
          <div className="section-head"><div><p className="kicker">Master mix totals</p><h2>Per gene</h2></div>
            <div className="button-row master-export-actions">
              <button className="ghost" type="button" onClick={copyMixTSV} disabled={!canFinalizePlan} data-testid="copy-mix-tsv-btn">Copy mix TSV</button>
              <button className="ghost" type="button" onClick={exportMixCsv} disabled={!canFinalizePlan} data-testid="export-mix-csv-btn">Export mix CSV</button>
            </div>
          </div>
          {mix.length === 0 && <div className="empty"><p className="muted">Compute to see mix totals.</p></div>}
          {mix.length > 0 && (
            <p className="muted" data-testid="mix-primer-concentration">
              Totals below list every pooled recipe component and individual transfer using the last computed recipe. Check Reaction recipe for each component’s stock and final concentration; batch totals include recipe overage.
            </p>
          )}
          {mix.length > 0 && (
            <div className="table-wrap">
              <div className="table-scroll">
                <table className="data mix-table">
                  <thead><tr><th>Gene</th><th>Assay recipe</th><th className="num">Wells</th><th>Master-mix component</th><th className="num">Per reaction (µL)</th><th className="num">Batch total (µL)</th></tr></thead>
                  <tbody>{mix.flatMap((row) => [
                    ...(row.components ?? []).map((component) => <tr key={`${row.Gene}-${component.name}`}>
                      <td>{row.Gene}</td><td>{row.recipe_name}</td><td className="num">{row.placed_reactions}</td><td>{component.name} · pooled mix</td><td className="num">{component.per_reaction_ul.toFixed(4)}</td><td className="num">{component.total_ul.toFixed(3)}</td>
                    </tr>),
                    ...(row.individual_transfers ?? []).map((component) => <tr key={`${row.Gene}-${component.name}-individual`}>
                      <td>{row.Gene}</td><td>{row.recipe_name}</td><td className="num">{row.placed_reactions}</td><td>{component.name} · individual well transfer</td><td className="num">{component.per_well_ul.toFixed(4)}</td><td className="num">{component.total_ul.toFixed(3)}</td>
                    </tr>),
                  ])}</tbody>
                </table>
              </div>
              {mix.some((row) => row.recipe_issues?.length) && <ul className="recipe-issues">{mix.flatMap((row) => (row.recipe_issues ?? []).map((issue) => <li key={`${row.Gene}-${issue}`}>{row.Gene}: {issue}</li>))}</ul>}
              {mix.some((row) => row.dilutions?.length) && <div className="dilution-guidance-list">{mix.flatMap((row) => (row.dilutions ?? []).map((dilution) => <p className="dilution-guidance" key={`${row.Gene}-${dilution.component}`}><strong>{row.Gene} — {dilution.component}: prepare {dilution.factor?.toFixed(1)}× working dilution</strong><span>{dilution.stock_ul?.toFixed(3)} µL stock + {dilution.water_ul?.toFixed(3)} µL water = {dilution.total_ul?.toFixed(3)} µL at {dilution.working_concentration} {dilution.unit}.</span></p>))}</div>}
            </div>
          )}
        </section>

        <section className="card notes" data-testid="notes-card">
          <div className="section-head"><div><p className="kicker">Notes & rules</p><h2>How placement works</h2></div></div>
          <ul className="bullets">
            <li>Replicates are adjacent in a row; if the row runs out, placement continues on the next row.</li>
            <li>Genes of the same chemistry are packed onto as few plates as possible; SYBR and TaqMan stay on separate plates.</li>
            <li>Each gene block begins at column 1. Any unused wells at the end of its row are left empty.</li>
            <li>Order within a gene: Samples → Standards → Positives (if any) → RT− → RNA− → Blank.</li>
            <li>Capacity depends on the selected {plateFormat}-well format; a gene that does not fit moves to a new plate.</li>
            <li>Mix overage increases master-mix volumes only; well counts stay the same.</li>
          </ul>
        </section>
      </div>
      </>}

      {activeView === 'recipe' && <div className="shell">
        <RecipeWorkflow
          apiBase={API_BASE}
          chemistry={recipeChemistry}
          recipes={recipesByChemistry}
          presets={presets}
          savedPresets={savedRecipePresets}
          onChemistryChange={setRecipeChemistry}
          sampleConcentration={sampleConcentration}
          onSampleConcentrationChange={setSampleConcentration}
          onRecipeChange={handleRecipeChange}
          onSavePreset={(chemistry, name, recipe) => {
            const namedRecipe = { ...recipe, name }
            setSavedRecipePresets((previous) => [{ name, chemistry, recipe: namedRecipe }, ...previous.filter((item) => !(item.chemistry === chemistry && item.name === name))].slice(0, 50))
            handleRecipeChange(chemistry, namedRecipe)
          }}
          onLoadPreset={(chemistry, recipe) => {
            if (recipe.name.startsWith('Legacy ')) {
              const forward = recipe.components.find((component) => component.name === 'Forward primer')
              if (forward?.stock_unit === 'uM') handlePrimerSourceChange(forward.stock >= 50 ? 'stock' : 'working')
            }
            handleRecipeChange(chemistry, recipe)
          }}
          plannedMix={mix}
          planIsStale={planIsStale}
        />
      </div>}

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
