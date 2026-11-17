import { useEffect, useState } from 'react'
import { GuidedTutorial, type TutorialStep } from './GuidedTutorial'

export type Chemistry = 'SYBR' | 'TaqMan'
export type RecipeComponent = {
  name: string
  mode: 'fixed' | 'fraction' | 'concentration'
  value: number
  stock: number
  stock_unit: string
  final: number
  final_unit: string
  in_master_mix: boolean
}
export type Recipe = {
  version: 1
  name: string
  total_volume_ul: number
  reference_volume_ul: number
  allow_scaling: boolean
  min_pipette_ul: number
  overage_pct: number
  sample_input: { mode: 'mass' | 'volume'; value: number; unit: 'ng' | 'uL' }
  constraints: {
    source: string
    min_volume_ul: number | null
    max_volume_ul: number | null
    max_input_ng: number | null
    max_sample_ul: number | null
  }
  components: RecipeComponent[]
}
export type RecipePreset = { key: string; chemistry: Chemistry; primer_source: 'working' | 'stock'; recipe: Recipe }
export type PlannedMix = {
  Gene: string
  Chemistry: string
  placed_reactions: number
  recipe_name?: string
  components?: Array<{ name: string; per_reaction_ul: number; total_ul: number }>
  individual_transfers?: Array<{ name: string; per_well_ul: number; total_ul: number }>
  recipe_issues?: string[]
  dilutions?: Array<{
    component: string
    stock_concentration: number
    working_concentration: number
    unit: string
    stock_ul: number | null
    water_ul: number | null
    total_ul: number | null
    factor: number | null
    issues: string[]
    note: string
  }>
}

type SavedPreset = { name: string; chemistry: Chemistry; recipe: Recipe }

type Props = {
  apiBase: string
  chemistry: Chemistry
  recipes: Record<Chemistry, Recipe> | null
  presets: RecipePreset[]
  savedPresets: SavedPreset[]
  onChemistryChange: (chemistry: Chemistry) => void
  sampleConcentration: string
  onSampleConcentrationChange: (value: string) => void
  onRecipeChange: (chemistry: Chemistry, recipe: Recipe) => void
  onSavePreset: (chemistry: Chemistry, name: string, recipe: Recipe) => void
  onLoadPreset: (chemistry: Chemistry, recipe: Recipe) => void
  plannedMix: PlannedMix[]
  planIsStale: boolean
}

type Evaluation = {
  evaluation: {
    components: Array<{ name: string; volume_ul: number; in_master_mix: boolean }>
    water_ul: number | null
    total_volume_ul: number | null
    sample_volume_ul: number | null
    issues: string[]
  }
  master_mix: { components: Array<{ name: string; per_reaction_ul: number; total_ul: number }>; reaction_equivalents: number; issues: string[] }
  issues: string[]
  input_mass_ng: number | null
  dilutions: NonNullable<PlannedMix['dilutions']>
}

type DilutionInput = {
  stock: string
  working: string
  needed: string
  minimum: string
  overage: string
  available: string
  unit: string
}

const UNIT_OPTIONS = ['uM', 'nM', 'mM', 'X', 'U/uL', 'ng/uL', 'ug/uL', 'mg/mL']

const recipeTutorialSteps: TutorialStep[] = [
  {
    selector: '[aria-label="Named recipe preset"]',
    title: 'Start from a named recipe',
    description: 'Choose the existing SYBR or TaqMan recipe, then edit a copy for your assay.',
    details: ['The 10 µM and 100 µM primer recipes keep the same final primer concentration.', 'Saved custom presets stay on this device.'],
  },
  {
    selector: '[data-testid="recipe-total-volume"]',
    title: 'Set reaction and sample input',
    description: 'Enter reaction volume and choose sample mass or volume.',
    details: ['Mass input needs sample concentration to calculate a transfer volume.', 'The service checks kit limits and reports the remaining water.'],
  },
  {
    selector: '[data-testid="recipe-components-wrap"]',
    title: 'Review each reagent',
    description: 'Choose fixed aliquots, fractions, or stock-to-final concentration.',
    details: ['Fixed aliquots remain fixed when scaling is allowed.', 'Reagents marked in the master mix are pooled before dispensing.'],
  },
  {
    selector: '[data-testid="recipe-batch-results"]',
    title: 'Check pooled transfer volumes',
    description: 'After computing a layout, review the real batch totals for each gene.',
    details: ['A per-reaction value below the minimum can still be feasible when the pooled transfer is large enough.', 'If a pooled stock transfer is too small, the planner gives a working dilution that keeps the same final concentration.'],
  },
]

const cloneRecipe = (recipe: Recipe): Recipe => JSON.parse(JSON.stringify(recipe)) as Recipe

const RecipeWorkflow = ({
  apiBase,
  chemistry,
  recipes,
  presets,
  savedPresets,
  onChemistryChange,
  sampleConcentration,
  onSampleConcentrationChange,
  onRecipeChange,
  onSavePreset,
  onLoadPreset,
  plannedMix,
  planIsStale,
}: Props) => {
  const recipe = recipes?.[chemistry]
  const recipeName = recipe?.name
  const evaluationPayload = recipe ? JSON.stringify({
    recipe,
    reaction_count: 1,
    sample_concentration_ng_ul: sampleConcentration ? Number(sampleConcentration) : null,
  }) : null
  const [evaluationResult, setEvaluationResult] = useState<{ key: string; value: Evaluation } | null>(null)
  const [evaluationError, setEvaluationError] = useState<{ key: string; message: string } | null>(null)
  const [presetChoice, setPresetChoice] = useState('')
  const [presetName, setPresetName] = useState('')
  const [saveMessage, setSaveMessage] = useState('')
  const [undoStack, setUndoStack] = useState<Recipe[]>([])
  const [dilutionInput, setDilutionInput] = useState<DilutionInput>({ stock: '100', working: '10', needed: '10', minimum: '0.5', overage: '10', available: '', unit: 'uM' })
  const [dilutionResult, setDilutionResult] = useState<{ stock_ul: number | null; water_ul: number | null; total_ul: number | null; factor: number | null; issues: string[] } | null>(null)
  const selectedPresets = presets.filter((item) => item.chemistry === chemistry)
  const selectedSavedPresets = savedPresets.filter((item) => item.chemistry === chemistry)

  useEffect(() => {
    setUndoStack([])
    setPresetChoice('')
    setPresetName('')
    setSaveMessage('')
  }, [chemistry])

  useEffect(() => {
    if (!recipeName) return
    const defaultPreset = presets.find((item) => item.chemistry === chemistry && item.recipe.name === recipeName)
    const savedPreset = savedPresets.find((item) => item.chemistry === chemistry && item.name === recipeName)
    if (defaultPreset) setPresetChoice(defaultPreset.key)
    else if (savedPreset) setPresetChoice(`saved:${savedPreset.name}`)
  }, [chemistry, recipeName, presets, savedPresets])

  useEffect(() => {
    if (!evaluationPayload) return
    let cancelled = false
    const requestKey = evaluationPayload
    setEvaluationError(null)
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${apiBase}/recipe/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestKey,
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data?.detail || 'Could not evaluate this recipe.')
        if (!cancelled) setEvaluationResult({ key: requestKey, value: data as Evaluation })
      } catch (error) {
        if (!cancelled) setEvaluationError({ key: requestKey, message: error instanceof Error ? error.message : 'Could not evaluate this recipe.' })
      }
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [apiBase, evaluationPayload])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${apiBase}/recipe/dilution`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stock_concentration: Number(dilutionInput.stock),
            working_concentration: Number(dilutionInput.working),
            needed_volume_ul: Number(dilutionInput.needed),
            min_pipette_ul: Number(dilutionInput.minimum),
            overage_pct: Number(dilutionInput.overage),
            available_stock_ul: dilutionInput.available ? Number(dilutionInput.available) : null,
          }),
        })
        const data = await response.json()
        if (!cancelled) setDilutionResult(data)
      } catch {
        if (!cancelled) setDilutionResult({ stock_ul: null, water_ul: null, total_ul: null, factor: null, issues: ['The isolated planner service could not calculate this dilution.'] })
      }
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [apiBase, dilutionInput])

  if (!recipe) {
    return <section className="card recipe-workflow"><p className="muted">Loading recipe presets from the planner service…</p></section>
  }

  const updateRecipe = (updater: (current: Recipe) => Recipe) => {
    const current = recipes?.[chemistry]
    if (!current) return
    setUndoStack((stack) => [...stack.slice(-29), cloneRecipe(current)])
    onRecipeChange(chemistry, updater(cloneRecipe(current)))
  }

  const undo = () => {
    const previous = undoStack[undoStack.length - 1]
    if (!previous) return
    onRecipeChange(chemistry, cloneRecipe(previous))
    setUndoStack((stack) => stack.slice(0, -1))
  }

  const applyChoice = (value: string) => {
    setPresetChoice(value)
    const defaultPreset = selectedPresets.find((item) => item.key === value)
    if (defaultPreset) onLoadPreset(chemistry, cloneRecipe(defaultPreset.recipe))
    const saved = selectedSavedPresets.find((item) => `saved:${item.name}` === value)
    if (saved) onLoadPreset(chemistry, cloneRecipe(saved.recipe))
  }

  const setComponent = (index: number, patch: Partial<RecipeComponent>) => {
    updateRecipe((current) => ({
      ...current,
      components: current.components.map((component, componentIndex) =>
        componentIndex === index ? { ...component, ...patch } : component
      ),
    }))
  }

  const masterMixRows = plannedMix.filter((row) => row.Chemistry === chemistry)
  const currentEvaluation = evaluationResult?.key === evaluationPayload ? evaluationResult.value : null
  const currentEvaluationError = evaluationError?.key === evaluationPayload ? evaluationError.message : null
  const evaluationPending = Boolean(evaluationPayload && !currentEvaluation && !currentEvaluationError)
  return (
    <section className="card recipe-workflow" data-testid="recipe-workflow">
      <div className="section-head">
        <div>
          <p className="kicker">Recipe & feasibility</p>
          <h2>Reaction mix</h2>
          <p className="muted">The API evaluates the recipe, water remainder, kit limits and pooled transfers. Kit limits require a named source; pipetting minimum and overage are planning preferences.</p>
        </div>
        <div className="recipe-actions">
          <GuidedTutorial steps={recipeTutorialSteps} startLabel="Recipe guide" />
          <button className="ghost" type="button" onClick={undo} disabled={!undoStack.length} data-testid="recipe-undo">Undo recipe edit</button>
          <button
            className="ghost"
            type="button"
            disabled={!presetChoice}
            onClick={() => applyChoice(presetChoice)}
            data-testid="recipe-reset"
          >Reset to selected preset</button>
        </div>
      </div>

      <div className="recipe-toolbar">
        <label className="control">
          <span>Assay chemistry</span>
          <select aria-label="Recipe chemistry" value={chemistry} onChange={(event) => onChemistryChange(event.target.value as Chemistry)}>
            <option value="SYBR">SYBR</option>
            <option value="TaqMan">TaqMan</option>
          </select>
        </label>
        <label className="control recipe-preset-control">
          <span>Named recipe</span>
          <select aria-label="Named recipe preset" value={presetChoice} onChange={(event) => applyChoice(event.target.value)}>
            <option value="">Choose a preset…</option>
            {selectedPresets.map((item) => <option key={item.key} value={item.key}>{item.recipe.name}</option>)}
            {selectedSavedPresets.map((item) => <option key={`saved:${item.name}`} value={`saved:${item.name}`}>{item.name} · saved</option>)}
          </select>
        </label>
      </div>

      <div className="recipe-summary-line">
        <span className="pill">{recipe.name || 'Unnamed recipe'}</span>
        <span className="muted-small">Final volume {recipe.total_volume_ul} µL · Reference {recipe.reference_volume_ul} µL</span>
        {evaluationPending && <span className="muted-small" aria-live="polite">Updating recipe check…</span>}
      </div>

      <div className="recipe-fields">
        <label className="field"><span className="kicker">Recipe name</span><input value={recipe.name} onChange={(event) => updateRecipe((current) => ({ ...current, name: event.target.value }))} data-testid="recipe-name" /></label>
        <label className="field"><span className="kicker">Total reaction (µL)</span><input type="number" min="0" step="any" value={recipe.total_volume_ul} onChange={(event) => updateRecipe((current) => ({ ...current, total_volume_ul: Number(event.target.value) }))} data-testid="recipe-total-volume" /></label>
        <label className="field"><span className="kicker">Reference volume (µL)</span><input type="number" min="0" step="any" value={recipe.reference_volume_ul} onChange={(event) => updateRecipe((current) => ({ ...current, reference_volume_ul: Number(event.target.value) }))} /></label>
        <label className="field"><span className="kicker">Pipetting minimum (µL)</span><input type="number" min="0" step="any" value={recipe.min_pipette_ul} onChange={(event) => updateRecipe((current) => ({ ...current, min_pipette_ul: Number(event.target.value) }))} data-testid="recipe-min-pipette" /></label>
        <label className="field"><span className="kicker">Mix overage (%)</span><input type="number" min="0" max="100" step="any" value={recipe.overage_pct} onChange={(event) => updateRecipe((current) => ({ ...current, overage_pct: Number(event.target.value) }))} /></label>
        <label className="field"><span className="kicker">Sample input mode</span><select value={recipe.sample_input.mode} onChange={(event) => updateRecipe((current) => ({ ...current, sample_input: { ...current.sample_input, mode: event.target.value as 'mass' | 'volume', unit: event.target.value === 'mass' ? 'ng' : 'uL' } }))}><option value="volume">Volume</option><option value="mass">Mass</option></select></label>
        <label className="field"><span className="kicker">Target sample input ({recipe.sample_input.mode === 'mass' ? 'ng' : 'µL'})</span><input type="number" min="0" step="any" value={recipe.sample_input.value} onChange={(event) => updateRecipe((current) => ({ ...current, sample_input: { ...current.sample_input, value: Number(event.target.value) } }))} data-testid="recipe-sample-input" /></label>
        <label className="field"><span className="kicker">Sample concentration (ng/µL)</span><input type="number" min="0" step="any" value={sampleConcentration} onChange={(event) => onSampleConcentrationChange(event.target.value)} placeholder={recipe.sample_input.mode === 'mass' ? 'Required for mass input' : 'Optional, enables mass-limit check'} /></label>
        <label className="toggle recipe-scaling-toggle"><input type="checkbox" checked={recipe.allow_scaling} onChange={(event) => updateRecipe((current) => ({ ...current, allow_scaling: event.target.checked }))} /><span className="toggle-ui" /><span className="toggle-label">Allow scaling from reference volume</span></label>
      </div>

      <details className="recipe-kit-limits" open>
        <summary>Manufacturer / kit limits</summary>
        <p className="muted-small">Enter only limits stated by the kit or protocol. These are enforced separately from your pipetting preference.</p>
        <div className="recipe-fields recipe-limit-fields">
          <label className="field"><span className="kicker">Limit source</span><input value={recipe.constraints.source} onChange={(event) => updateRecipe((current) => ({ ...current, constraints: { ...current.constraints, source: event.target.value } }))} placeholder="Kit name, protocol, or document" /></label>
          <label className="field"><span className="kicker">Minimum reaction (µL)</span><input type="number" min="0" step="any" value={recipe.constraints.min_volume_ul ?? ''} onChange={(event) => updateRecipe((current) => ({ ...current, constraints: { ...current.constraints, min_volume_ul: event.target.value === '' ? null : Number(event.target.value) } }))} /></label>
          <label className="field"><span className="kicker">Maximum reaction (µL)</span><input type="number" min="0" step="any" value={recipe.constraints.max_volume_ul ?? ''} onChange={(event) => updateRecipe((current) => ({ ...current, constraints: { ...current.constraints, max_volume_ul: event.target.value === '' ? null : Number(event.target.value) } }))} /></label>
          <label className="field"><span className="kicker">Maximum input mass (ng)</span><input type="number" min="0" step="any" value={recipe.constraints.max_input_ng ?? ''} onChange={(event) => updateRecipe((current) => ({ ...current, constraints: { ...current.constraints, max_input_ng: event.target.value === '' ? null : Number(event.target.value) } }))} /></label>
          <label className="field"><span className="kicker">Maximum sample volume (µL)</span><input type="number" min="0" step="any" value={recipe.constraints.max_sample_ul ?? ''} onChange={(event) => updateRecipe((current) => ({ ...current, constraints: { ...current.constraints, max_sample_ul: event.target.value === '' ? null : Number(event.target.value) } }))} /></label>
        </div>
      </details>

      <div className="section-head recipe-components-head">
        <div><p className="kicker">Reagents</p><h3>Per-reaction components</h3><p className="muted-small">Fixed aliquots stay fixed when scaling is allowed. Fractions and concentration-based volumes follow the total reaction.</p></div>
        <button className="ghost" type="button" onClick={() => updateRecipe((current) => ({ ...current, components: [...current.components, { name: '', mode: 'fixed', value: 0, stock: 1, stock_unit: 'uM', final: 0, final_unit: 'uM', in_master_mix: true }] }))} data-testid="recipe-add-component">+ Add reagent</button>
      </div>

      <div className="table-wrap recipe-components-wrap" data-testid="recipe-components-wrap">
        <div className="table-scroll">
          <table className="data recipe-components-table">
            <thead><tr><th>Reagent</th><th>Mode</th><th>Amount / stock</th><th>Stock unit</th><th>Final concentration</th><th>Final unit</th><th>In master mix</th><th></th></tr></thead>
            <tbody>
              {recipe.components.map((component, index) => (
                <tr key={`${index}-${component.name}`}>
                  <td><input aria-label={`Reagent ${index + 1} name`} value={component.name} onChange={(event) => setComponent(index, { name: event.target.value })} /></td>
                  <td><select aria-label={`Reagent ${index + 1} mode`} value={component.mode} onChange={(event) => setComponent(index, { mode: event.target.value as RecipeComponent['mode'] })}><option value="fixed">Fixed µL</option><option value="fraction">Fraction</option><option value="concentration">Stock → final</option></select></td>
                  <td>{component.mode === 'concentration' ? <input aria-label={`Reagent ${index + 1} stock value`} type="number" min="0" step="any" value={component.stock} onChange={(event) => setComponent(index, { stock: Number(event.target.value) })} /> : <input aria-label={`Reagent ${index + 1} amount`} type="number" min="0" step="any" value={component.value} onChange={(event) => setComponent(index, { value: Number(event.target.value) })} />}</td>
                  <td><select aria-label={`Reagent ${index + 1} stock unit`} value={component.stock_unit} onChange={(event) => setComponent(index, { stock_unit: event.target.value })}>{UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></td>
                  <td>{component.mode === 'concentration' ? <input aria-label={`Reagent ${index + 1} final value`} type="number" min="0" step="any" value={component.final} onChange={(event) => setComponent(index, { final: Number(event.target.value) })} /> : <span className="muted-small">—</span>}</td>
                  <td><select aria-label={`Reagent ${index + 1} final unit`} value={component.final_unit} onChange={(event) => setComponent(index, { final_unit: event.target.value })}>{UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></td>
                  <td><input aria-label={`Reagent ${index + 1} in master mix`} type="checkbox" checked={component.in_master_mix} onChange={(event) => setComponent(index, { in_master_mix: event.target.checked })} /></td>
                  <td><button className="ghost compact-button" type="button" onClick={() => updateRecipe((current) => ({ ...current, components: current.components.filter((_, componentIndex) => componentIndex !== index) }))} aria-label={`Remove reagent ${index + 1}`}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="recipe-save-row">
        <label className="field"><span className="kicker">Save as named preset</span><input value={presetName} onChange={(event) => { setPresetName(event.target.value); setSaveMessage('') }} placeholder="e.g. My 20 µL SYBR mix" data-testid="recipe-preset-name" /></label>
        <button className="primary" type="button" disabled={!presetName.trim()} onClick={() => {
          onSavePreset(chemistry, presetName.trim(), { ...cloneRecipe(recipe), name: presetName.trim() })
          setSaveMessage(`Saved “${presetName.trim()}” on this device.`)
          setPresetChoice(`saved:${presetName.trim()}`)
        }} data-testid="recipe-save-preset">Save preset</button>
        {saveMessage && <span className="status-note" role="status">{saveMessage}</span>}
      </div>

      <div className="recipe-results" data-testid="recipe-evaluation">
        <div className="section-head"><div><p className="kicker">Single-reaction check</p><h3>Water remainder and feasibility</h3></div></div>
        {currentEvaluationError && <div className="alert error" role="alert">{currentEvaluationError}</div>}
        {evaluationPending && <p className="muted-small" role="status" data-testid="recipe-evaluation-pending">Waiting for the current recipe calculation…</p>}
        {currentEvaluation && <>
          <div className="recipe-metrics">
            <div className="meta-card"><p>Total reaction</p><strong>{currentEvaluation.evaluation.total_volume_ul ?? '—'} µL</strong></div>
            <div className="meta-card"><p>Sample volume</p><strong>{currentEvaluation.evaluation.sample_volume_ul == null ? '—' : `${currentEvaluation.evaluation.sample_volume_ul.toFixed(3)} µL`}</strong></div>
            <div className="meta-card"><p>Water remainder</p><strong>{currentEvaluation.evaluation.water_ul == null ? '—' : `${currentEvaluation.evaluation.water_ul.toFixed(3)} µL`}</strong></div>
          </div>
          <div className="recipe-component-results">
            {currentEvaluation.evaluation.components.map((component) => <div className="recipe-result-row" key={component.name}><span>{component.name}</span><strong>{component.volume_ul.toFixed(4)} µL</strong><span className="muted-small">{component.in_master_mix ? 'master mix' : 'individual transfer'}</span></div>)}
          </div>
          {currentEvaluation.issues.length > 0 ? <ul className="recipe-issues" data-testid="recipe-issues">{currentEvaluation.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p className="status-note">No recipe or transfer constraints are currently flagged for one reaction.</p>}
        </>}
      </div>

      <div className="recipe-results batch-results" data-testid="recipe-batch-results">
        <div className="section-head"><div><p className="kicker">Current layout</p><h3>Pooled transfer check</h3><p className="muted-small">The plan endpoint counts actual wells and controls for each gene; this is the batch total used to prepare the master mix.</p></div></div>
        {planIsStale && <p className="warning-note">Recipe or layout inputs changed since the last calculation. Recompute the layout to refresh these batch totals.</p>}
        {!masterMixRows.length && <p className="muted">Compute a plate layout to see pooled transfer volumes and working-dilution suggestions.</p>}
        {!planIsStale && masterMixRows.map((row) => <article className="batch-recipe-card" key={row.Gene}>
          <div className="batch-recipe-title"><strong>{row.Gene}</strong><span className="muted-small">{row.placed_reactions} wells · {row.recipe_name}</span></div>
          <div className="recipe-component-results">{(row.components ?? []).map((component) => <div className="recipe-result-row" key={component.name}><span>{component.name}</span><strong>{component.total_ul.toFixed(3)} µL</strong><span className="muted-small">{component.per_reaction_ul.toFixed(4)} µL / reaction</span></div>)}</div>
          {(row.individual_transfers ?? []).length > 0 && <div className="individual-transfer-list"><strong>Individual well transfers (not pooled; no overage added)</strong>{row.individual_transfers?.map((component) => <div className="recipe-result-row" key={component.name}><span>{component.name}</span><strong>{component.per_well_ul.toFixed(4)} µL / well</strong><span className="muted-small">{component.total_ul.toFixed(3)} µL for {row.placed_reactions} wells</span></div>)}</div>}
          {(row.recipe_issues ?? []).length > 0 && <ul className="recipe-issues">{row.recipe_issues?.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
          {(row.dilutions ?? []).map((dilution) => <div className="dilution-guidance" key={dilution.component}>
            <strong>{dilution.component}: prepare a {dilution.factor?.toFixed(1)}× working dilution</strong>
            <span>{dilution.stock_ul?.toFixed(3)} µL of {dilution.stock_concentration} {dilution.unit} stock + {dilution.water_ul?.toFixed(3)} µL water = {dilution.total_ul?.toFixed(3)} µL at {dilution.working_concentration} {dilution.unit}.</span>
            <span className="muted-small">{dilution.note}</span>
          </div>)}
        </article>)}
      </div>

      <div className="recipe-results dilution-tool" data-testid="dilution-tool">
        <div className="section-head"><div><p className="kicker">Dilution planner</p><h3>Prepare a working solution</h3><p className="muted-small">Enter concentrations in the same unit. The planner shows the stock and water transfers, including overage and the minimum pipetting volume.</p></div></div>
        <div className="recipe-fields dilution-fields">
          <label className="field"><span className="kicker">Stock concentration</span><input type="number" min="0" step="any" value={dilutionInput.stock} onChange={(event) => setDilutionInput((current) => ({ ...current, stock: event.target.value }))} /></label>
          <label className="field"><span className="kicker">Working concentration</span><input type="number" min="0" step="any" value={dilutionInput.working} onChange={(event) => setDilutionInput((current) => ({ ...current, working: event.target.value }))} /></label>
          <label className="field"><span className="kicker">Concentration unit</span><select value={dilutionInput.unit} onChange={(event) => setDilutionInput((current) => ({ ...current, unit: event.target.value }))}>{UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
          <label className="field"><span className="kicker">Volume needed (µL)</span><input type="number" min="0" step="any" value={dilutionInput.needed} onChange={(event) => setDilutionInput((current) => ({ ...current, needed: event.target.value }))} /></label>
          <label className="field"><span className="kicker">Pipetting minimum (µL)</span><input type="number" min="0" step="any" value={dilutionInput.minimum} onChange={(event) => setDilutionInput((current) => ({ ...current, minimum: event.target.value }))} /></label>
          <label className="field"><span className="kicker">Overage (%)</span><input type="number" min="0" max="100" step="any" value={dilutionInput.overage} onChange={(event) => setDilutionInput((current) => ({ ...current, overage: event.target.value }))} /></label>
          <label className="field"><span className="kicker">Available stock (µL, optional)</span><input type="number" min="0" step="any" value={dilutionInput.available} onChange={(event) => setDilutionInput((current) => ({ ...current, available: event.target.value }))} placeholder="Leave blank if unknown" /></label>
        </div>
        {dilutionResult && <div className="dilution-result" aria-live="polite">
          <div className="recipe-metrics">
            <div className="meta-card"><p>Stock to transfer</p><strong>{dilutionResult.stock_ul == null ? '—' : `${dilutionResult.stock_ul.toFixed(3)} µL`}</strong></div>
            <div className="meta-card"><p>Water to add</p><strong>{dilutionResult.water_ul == null ? '—' : `${dilutionResult.water_ul.toFixed(3)} µL`}</strong></div>
            <div className="meta-card"><p>Working solution</p><strong>{dilutionResult.total_ul == null ? '—' : `${dilutionResult.total_ul.toFixed(3)} µL`}</strong></div>
            <div className="meta-card"><p>Dilution factor</p><strong>{dilutionResult.factor == null ? '—' : `${dilutionResult.factor.toFixed(2)}×`}</strong></div>
          </div>
          {dilutionResult.issues.length > 0 && <ul className="recipe-issues">{dilutionResult.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
        </div>}
      </div>
    </section>
  )
}

export default RecipeWorkflow
