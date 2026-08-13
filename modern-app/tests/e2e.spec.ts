import { test, expect } from '@playwright/test'

type PlanLayoutRow = {
  Plate: string
  Well: string
  Gene: string
  Type: string
  Label: string
  SampleIndex?: number
  Replicate: number
  Group?: string
  Extras?: string[]
}

type PlanSummaryRow = {
  plate: string
  used: number
  empty: number
}

type PlanResponse = {
  layout: PlanLayoutRow[]
  summary: PlanSummaryRow[]
}

const waitForApi = async (request: { get: (url: string) => Promise<{ status: () => number }> }) => {
  await expect
    .poll(
      async () => {
        try {
          const res = await request.get('http://127.0.0.1:8003/openapi.json')
          return res.status()
        } catch {
          return 0
        }
      },
      { timeout: 30_000 }
    )
    .toBe(200)
}

test('API keeps repeated sample IDs as distinct sample occurrences', async ({ request }) => {
  await waitForApi(request)

  const res = await request.post('http://127.0.0.1:8003/plan', {
    data: {
      num_samples: 0,
      num_standards: 0,
      num_pos: 0,
      replicates: 2,
      overage_pct: 0,
      place_gapdh_separate: false,
      include_rtneg: false,
      include_rnaneg: false,
      use_pasted_samples: true,
      pasted_samples: ['Mouse-7\tcontrol', 'Mouse-7\ttreated'],
      genes: [{ name: 'Gapdh', chemistry: 'SYBR' }],
      gene_plate_overrides: {}
    }
  })

  expect(res.status()).toBe(200)
  const json = (await res.json()) as PlanResponse
  const sampleWells = json.layout.filter((row) => row.Type === 'Sample')

  expect(sampleWells).toHaveLength(4)
  expect(sampleWells.map((row) => row.Label)).toEqual(['Mouse-7', 'Mouse-7', 'Mouse-7', 'Mouse-7'])
  expect(sampleWells.map((row) => row.Well)).toEqual(['A1', 'A2', 'A3', 'A4'])
  expect(sampleWells.map((row) => row.SampleIndex)).toEqual([1, 1, 2, 2])
  expect(sampleWells.map((row) => row.Group)).toEqual(['control', 'control', 'treated', 'treated'])
  expect(sampleWells.map((row) => row.Extras)).toEqual([
    ['control'],
    ['control'],
    ['treated'],
    ['treated']
  ])
})

test('API packs genes by chemistry and aligns each gene block to column 1', async ({ request }) => {
  await waitForApi(request)

  const payload = {
    num_samples: 3,
    num_standards: 0,
    num_pos: 0,
    replicates: 2,
    overage_pct: 0,
    place_gapdh_separate: false,
    include_rtneg: false,
    include_rnaneg: false,
    use_pasted_samples: false,
    pasted_samples: [],
    genes: [
      { name: 'GeneA', chemistry: 'SYBR' },
      { name: 'GeneB', chemistry: 'SYBR' },
      { name: 'GeneC', chemistry: 'SYBR' }
    ],
    gene_plate_overrides: {}
  }

  const res = await request.post('http://127.0.0.1:8003/plan', { data: payload })
  expect(res.status()).toBe(200)
  const json = (await res.json()) as PlanResponse

  // All three genes should fit onto a single plate when they share chemistry.
  expect(json.summary).toHaveLength(1)
  expect(json.summary[0].plate).toBe('Plate 1')

  const starts = (gene: string) =>
    json.layout.find((r) => r.Gene === gene && r.Type === 'Sample' && r.Label === 'S1' && r.Replicate === 1)

  // Each gene block should start at column 1 (new row) rather than mid-row.
  expect(starts('GeneA')?.Well).toBe('A1')
  expect(starts('GeneB')?.Well).toBe('B1')
  expect(starts('GeneC')?.Well).toBe('C1')
})

test('API does not mix chemistries on a single plate', async ({ request }) => {
  await waitForApi(request)

  const payload = {
    num_samples: 1,
    num_standards: 0,
    num_pos: 0,
    replicates: 2,
    overage_pct: 0,
    place_gapdh_separate: false,
    include_rtneg: false,
    include_rnaneg: false,
    use_pasted_samples: false,
    pasted_samples: [],
    genes: [
      { name: 'GeneSYBR', chemistry: 'SYBR' },
      { name: 'GeneTaq', chemistry: 'TaqMan' }
    ],
    gene_plate_overrides: {}
  }

  const res = await request.post('http://127.0.0.1:8003/plan', { data: payload })
  expect(res.status()).toBe(200)
  const json = (await res.json()) as PlanResponse

  // Even though both genes could fit on one plate by wells, chemistry separation forces a new plate.
  expect(json.summary.map((s) => s.plate)).toEqual(['Plate 1', 'Plate 2'])

  const sybrStart = json.layout.find((r) => r.Gene === 'GeneSYBR' && r.Type === 'Sample' && r.Label === 'S1' && r.Replicate === 1)
  const taqStart = json.layout.find((r) => r.Gene === 'GeneTaq' && r.Type === 'Sample' && r.Label === 'S1' && r.Replicate === 1)
  expect(sybrStart?.Plate).toBe('Plate 1')
  expect(sybrStart?.Well).toBe('A1')
  expect(taqStart?.Plate).toBe('Plate 2')
  expect(taqStart?.Well).toBe('A1')
})

test('qPCR planner flow', async ({ page, request }) => {
  await waitForApi(request)
  await page.goto('/')
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; } .signature { display: none !important; }' })
  await page.getByText('qPCR plate plans without guesswork').waitFor({ timeout: 60000 })

  const setupOverlay = page.getByTestId('setup-overlay')
  if (await setupOverlay.isVisible()) {
    await page.getByTestId('setup-finish').click()
    await expect(setupOverlay).toBeHidden()
  }

  // Use a long pasted list so the run spans at least two plates
  const samples = Array.from({ length: 80 }, (_, i) => `Sample${i + 1}`).join('\n')
  const textarea = page.locator('textarea')
  await textarea.first().waitFor({ state: 'visible', timeout: 30000 })
  await textarea.fill(samples)

  const samplesCard = page.getByTestId('samples-card')
  const previewCard = page.getByTestId('preview-card')
  const outputCard = page.getByTestId('output-card')
  const masterCard = page.getByTestId('master-card')
  const notesCard = page.getByTestId('notes-card')

  // Initial plan view (before compute) + plan card
  await expect(page).toHaveScreenshot('plan_view.png', { fullPage: true })
  await expect(samplesCard).toHaveScreenshot('plan_tab.png')

  await page.getByTestId('calculate-btn').click()
  // Confirm plan finished and spans multiple plates
  await expect(page.getByRole('cell', { name: 'Plate 1' }).first()).toBeVisible()
  const plateSelect = previewCard.locator('.plate-select')
  await expect(plateSelect).toBeVisible()
  await plateSelect.selectOption({ label: 'Plate 2' })
  await expect(page.getByRole('cell', { name: 'Plate 2' }).first()).toBeVisible()
  await expect(previewCard).toHaveScreenshot('plate_preview.png')

  // Full page after compute (layout + mix)
  await expect(page).toHaveScreenshot('layout_full.png', { fullPage: true })
  await expect(page).toHaveScreenshot('example_run.png', { fullPage: true })

  // Layout/output card
  await expect(outputCard).toHaveScreenshot('output_tab.png')

  // Master mix card
  await expect(masterCard).toHaveScreenshot('master_mix.png')
  await expect(masterCard).toHaveScreenshot('master_tab.png')

  // Notes card
  await expect(notesCard).toHaveScreenshot('notes_card.png')
  await expect(notesCard).toHaveScreenshot('notes_tab.png')
})

test('pasted samples keep extra columns in output table', async ({ page, request }) => {
  await waitForApi(request)
  await page.goto('/')
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; } .signature { display: none !important; }' })
  await page.getByText('qPCR plate plans without guesswork').waitFor({ timeout: 60000 })

  const setupOverlay = page.getByTestId('setup-overlay')
  if (await setupOverlay.isVisible()) {
    await page.getByTestId('setup-finish').click()
    await expect(setupOverlay).toBeHidden()
  }

  const textarea = page.locator('textarea').first()
  await textarea.waitFor({ state: 'visible', timeout: 30000 })

  const sampleBlock = [
    '321\tMale\ttnf\told age',
    'C577\tMale\tsaline\tmiddle age',
    'C5711\tFemale\tsaline\tmiddle age'
  ].join('\n')

  await textarea.fill(sampleBlock)
  await page.getByTestId('calculate-btn').click()

  await expect(page.getByRole('cell', { name: 'Plate 1' }).first()).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('cell', { name: 'Extra 1' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Extra 3' })).toBeVisible()

  // The first sample row should surface the extra fields in order.
  await expect(page.getByRole('cell', { name: 'Male' }).first()).toBeVisible()
  await expect(page.getByRole('cell', { name: 'tnf' }).first()).toBeVisible()
  await expect(page.getByRole('cell', { name: 'old age' }).first()).toBeVisible()
})
