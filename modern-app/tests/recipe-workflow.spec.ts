import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const apiBase = 'http://127.0.0.1:18512'
const appBase = 'http://127.0.0.1:19512'

test('recipe endpoints preserve primer dose and report pipetting/dilution limits', async ({ request }) => {
  const presetsResponse = await request.get(`${apiBase}/recipes/presets`)
  expect(presetsResponse.status()).toBe(200)
  const presetData = await presetsResponse.json()
  expect(presetData.presets).toHaveLength(4)

  const working = presetData.presets.find((item: { chemistry: string; primer_source: string }) => item.chemistry === 'SYBR' && item.primer_source === 'working')
  const stock = presetData.presets.find((item: { chemistry: string; primer_source: string }) => item.chemistry === 'SYBR' && item.primer_source === 'stock')
  const workingEval = await request.post(`${apiBase}/recipe/evaluate`, { data: { recipe: working.recipe, reaction_count: 20 } })
  const stockEval = await request.post(`${apiBase}/recipe/evaluate`, { data: { recipe: stock.recipe, reaction_count: 1 } })
  expect(workingEval.status()).toBe(200)
  expect(stockEval.status()).toBe(200)
  const workingResult = await workingEval.json()
  const stockResult = await stockEval.json()
  const workingPrimer = workingResult.evaluation.components.find((item: { name: string }) => item.name === 'Forward primer')
  const stockPrimer = stockResult.evaluation.components.find((item: { name: string }) => item.name === 'Forward primer')
  expect(working.recipe.components.find((item: { name: string }) => item.name === 'Forward primer').stock * workingPrimer.volume_ul / 15).toBeCloseTo(0.2)
  expect(stock.recipe.components.find((item: { name: string }) => item.name === 'Forward primer').stock * stockPrimer.volume_ul / 15).toBeCloseTo(0.2)
  expect(stockResult.issues.some((issue: string) => issue.includes('pipetting minimum'))).toBeTruthy()
  expect(stockResult.dilutions.some((item: { component: string; working_concentration: number }) => item.component === 'Forward primer' && item.working_concentration === 10)).toBeTruthy()

  const dilutionResponse = await request.post(`${apiBase}/recipe/dilution`, { data: {
    stock_concentration: 100, working_concentration: 10, needed_volume_ul: 0.5, min_pipette_ul: 0.5, overage_pct: 0,
  } })
  const dilution = await dilutionResponse.json()
  expect(dilution.stock_ul).toBeGreaterThanOrEqual(0.5)
  expect(dilution.factor).toBeCloseTo(10)
})

test('a fresh Planner starts with empty samples and rejects an empty plan without placeholders', async ({ page }) => {
  await page.goto(appBase)
  await expect(page.getByTestId('setup-overlay')).toHaveCount(0)
  await expect(page.getByTestId('samples-textarea')).toHaveValue('')
  const responsePromise = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
  await page.getByTestId('calculate-btn').click()
  expect((await responsePromise).status()).toBe(400)
  await expect(page.locator('.alert.error')).toContainText('No samples parsed from pasted list')
  await expect(page.locator('.layout-table')).toHaveCount(0)
})

test('template budget sums each biological sample and gates unknown, invalid, and insufficient stock', async ({ page }) => {
  await page.goto(appBase)
  await page.getByTestId('samples-textarea').fill('Mouse-1')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()

  const compute = async () => {
    const responsePromise = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
    await page.getByTestId('calculate-btn').click()
    expect((await responsePromise).status()).toBe(200)
  }

  await compute()
  const row = page.getByTestId('template-budget-row').filter({ hasText: 'Mouse-1' })
  await expect(row).toHaveCount(1)
  await expect(row.locator('td').nth(4)).toHaveText('4')
  await expect(row.locator('td').nth(5)).not.toHaveText('—')
  await expect(row).toContainText('unknown')
  await expect(page.getByTestId('unknown-template-confirmation-note')).toContainText('confirms enough stock is available')
  await expect(page.getByTestId('plan-review-confirmation')).toBeEnabled()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeDisabled()

  const sampleId = (await row.locator('td').nth(2).textContent())?.trim() ?? ''
  const available = row.getByLabel(`Available template volume in µL for Mouse-1 (${sampleId})`)
  await page.getByTestId('plan-review-confirmation').check()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeEnabled()
  await page.getByTestId('plan-review-confirmation').uncheck()

  await available.fill('-1')
  await expect(available).toHaveValue('-1')
  await expect(row.locator('td').nth(4)).toHaveText('—')
  await expect(row.locator('td').nth(5)).toHaveText('Recalculate')
  await expect(row.locator('td').nth(7)).toContainText('Recalculate')
  await expect(page.getByTestId('plan-review-confirmation')).toBeDisabled()
  const invalidRequest = page.waitForRequest((request) => request.url() === `${apiBase}/plan` && request.method() === 'POST')
  await compute()
  expect((await invalidRequest).postDataJSON().template_available_ul[sampleId]).toBe('-1')
  await expect(row).toContainText('invalid')
  await expect(page.getByTestId('plan-review-confirmation')).toBeDisabled()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeDisabled()

  await available.fill('0')
  await compute()
  await expect(row).toContainText('insufficient')
  await expect(page.getByTestId('template-budget-block')).toContainText('Known insufficient or invalid template availability')
  await expect(page.getByTestId('analysis-handoff-btn')).toBeDisabled()

  await available.fill('100')
  await compute()
  await expect(row).toContainText('enough')
  await expect(page.getByTestId('plan-review-confirmation')).toBeEnabled()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeDisabled()
  await page.getByTestId('plan-review-confirmation').check()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeEnabled()
})

test('template availability is package persisted and only restores review after exact recalculation', async ({ page }) => {
  await page.goto(appBase)
  await page.getByTestId('samples-textarea').fill('Mouse-1')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()

  const compute = async () => {
    const responsePromise = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
    await page.getByTestId('calculate-btn').click()
    expect((await responsePromise).status()).toBe(200)
  }

  await compute()
  const budgetRow = page.getByTestId('template-budget-row').filter({ hasText: 'Mouse-1' })
  const sampleId = (await budgetRow.locator('td').nth(2).textContent())?.trim() ?? ''
  await budgetRow.getByTestId('template-available-volume').fill('100')
  await compute()
  await expect(budgetRow).toContainText('enough')
  await page.getByTestId('plan-review-confirmation').check()

  await page.getByText('Saved experiments and packages').click()
  await page.getByTestId('package-name').fill('Stock budget review')
  await page.getByTestId('save-local-package').click()
  const savedPackage = await page.evaluate(() => JSON.parse(localStorage.getItem('easylab-next:qpcr-planner:experiments:v1') ?? '[]')[0])
  expect(savedPackage.settings.templateAvailableUl[sampleId]).toBe('100')
  expect(savedPackage.settings.templateBudget.rows[0].status).toBe('enough')
  expect(savedPackage.settings.planReviewConfirmed).toBe(true)
  expect(savedPackage.planFingerprint).toContain('template_available_ul')

  await page.getByTestId('open-local-package').click()
  await expect(page.getByRole('status')).toContainText('recalculated its layout from the saved inputs')
  const restoredRow = page.getByTestId('template-budget-row').filter({ hasText: 'Mouse-1' })
  await expect(restoredRow).toContainText('enough')
  await expect(restoredRow.getByTestId('template-available-volume')).toHaveValue('100')
  await expect(page.getByTestId('plan-review-confirmation')).toBeChecked()

  await page.getByTestId('samples-textarea').fill('Mouse-2')
  await expect(page.getByTestId('template-budget-row')).toHaveCount(0)
  await compute()
  const remappedRow = page.getByTestId('template-budget-row').filter({ hasText: 'Mouse-2' })
  await expect(remappedRow).toContainText('unknown')
  await expect(remappedRow.getByTestId('template-available-volume')).toHaveValue('')
  await expect(page.getByTestId('plan-review-confirmation')).not.toBeChecked()
})

test('new experiments clear sample availability before any new plan', async ({ page }) => {
  await page.goto(appBase)
  await page.getByTestId('samples-textarea').fill('Mouse-1')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()
  const compute = async () => {
    const responsePromise = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
    await page.getByTestId('calculate-btn').click()
    expect((await responsePromise).status()).toBe(200)
  }
  await compute()
  const budgetRow = page.getByTestId('template-budget-row').filter({ hasText: 'Mouse-1' })
  await budgetRow.getByTestId('template-available-volume').fill('100')
  await compute()
  await expect(budgetRow).toContainText('enough')

  await page.getByText('Saved experiments and packages').click()
  await page.getByTestId('new-experiment').click()
  await expect(page.getByTestId('samples-textarea')).toHaveValue('')
  await expect(page.getByTestId('template-budget-row')).toHaveCount(0)
  await page.getByTestId('samples-textarea').fill('Mouse-1')
  await page.locator('.gene-input').first().fill('Ccl2')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await compute()
  const newRow = page.getByTestId('template-budget-row').filter({ hasText: 'Mouse-1' })
  await expect(newRow).toContainText('unknown')
  await expect(newRow.getByTestId('template-available-volume')).toHaveValue('')
})

test('custom and renamed recipe components appear in mix display, TSV copy and CSV export', async ({ page }) => {
  await page.goto(appBase)
  if (await page.getByTestId('setup-overlay').isVisible()) await page.getByTestId('setup-finish').click()
  await page.getByTestId('recipe-tab').click()
  await page.getByLabel('Reagent 1 name').fill('Custom qPCR mix')
  await page.getByTestId('recipe-add-component').click()
  await page.getByLabel('Reagent 4 name').fill('PCR enhancer')
  await page.getByLabel('Reagent 4 mode').selectOption('fraction')
  await page.getByLabel('Reagent 4 amount').fill('0.02')

  await page.getByRole('button', { name: 'Plate layout' }).click()
  await page.getByTestId('samples-textarea').fill('Mouse-1\nMouse-2')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()
  const responsePromise = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
  await page.getByTestId('calculate-btn').click()
  expect((await responsePromise).status()).toBe(200)

  const enhancerRow = page.getByTestId('master-card').getByRole('row').filter({ has: page.getByRole('cell', { name: 'Ccl2', exact: true }) }).filter({ hasText: 'PCR enhancer' })
  await expect(enhancerRow).toHaveCount(1)
  await expect(enhancerRow.locator('td').nth(3)).toContainText('PCR enhancer')
  await expect(enhancerRow.locator('td').nth(4)).toHaveText('0.3000')
  const wells = Number(await enhancerRow.locator('td').nth(2).textContent())
  const preparationTotal = Number(await enhancerRow.locator('td').nth(5).textContent())
  expect(preparationTotal).toBeCloseTo(0.3 * wells * 1.1)

  await page.getByTestId('plan-review-confirmation').check()
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { Object.assign(window, { copiedMix: text }) },
  } }))
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByTestId('copy-mix-tsv-btn').click()
  const tsv = await page.evaluate(() => (window as Window & { copiedMix: string }).copiedMix)
  expect(tsv.split('\n')[0]).toBe('Gene\tRecipe\tWells\tComponent\tPreparation type\tPer reaction/well (µL)\tPreparation total (µL)\tOverage included')
  expect(tsv).toContain('Custom qPCR mix')
  expect(tsv).toContain('PCR enhancer')
  expect(tsv).toContain('Pooled master mix')

  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-mix-csv-btn').click()
  const download = await downloadPromise
  const csvPath = await download.path()
  const csv = await readFile(csvPath!, 'utf8')
  expect(csv).toContain('"Per reaction/well (µL)"')
  expect(csv).toContain('"Preparation total (µL)"')
  expect(csv).toContain('PCR enhancer')
  expect(csv).toContain('Custom qPCR mix')
})

test('recipe results hide stale values and ignore a delayed response after an edit', async ({ page }) => {
  let releaseDelayedResponse: () => void = () => {}
  let markDelayedRequestSeen: () => void = () => {}
  const delayedResponse = new Promise<void>((resolve) => { releaseDelayedResponse = resolve })
  const delayedRequestSeen = new Promise<void>((resolve) => { markDelayedRequestSeen = resolve })

  await page.route(`${apiBase}/recipe/evaluate`, async (route) => {
    const payload = route.request().postDataJSON()
    if (payload.recipe.total_volume_ul === 20) {
      markDelayedRequestSeen()
      await delayedResponse
    }
    await route.continue()
  })

  try {
    await page.goto(appBase)
    if (await page.getByTestId('setup-overlay').isVisible()) await page.getByTestId('setup-finish').click()
    await page.getByTestId('recipe-tab').click()
    const resultPanel = page.getByTestId('recipe-evaluation')
    await expect(resultPanel.locator('.recipe-metrics')).toContainText('15 µL')

    await page.getByTestId('recipe-total-volume').fill('20')
    await delayedRequestSeen
    await expect(resultPanel.locator('.recipe-metrics')).toHaveCount(0)
    await expect(resultPanel).toContainText('Waiting for the current recipe calculation')

    await page.getByTestId('recipe-total-volume').fill('25')
    await expect(resultPanel.locator('.recipe-metrics')).toContainText('25 µL')
    releaseDelayedResponse()
    await expect(resultPanel.locator('.recipe-metrics')).toContainText('25 µL')
    await expect(resultPanel.locator('.recipe-metrics')).not.toContainText('20 µL')
  } finally {
    releaseDelayedResponse()
  }
})

test('planner edits, saves and reopens a local experiment and exports stable analysis IDs', async ({ page }) => {
  await page.goto(appBase)
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; } .signature { display: none !important; }' })
  await expect(page.getByRole('heading', { name: 'qPCR plate plans without guesswork' })).toBeVisible()
  if (await page.getByTestId('setup-overlay').isVisible()) {
    await page.getByTestId('setup-finish').click()
    await expect(page.getByTestId('setup-overlay')).toBeHidden()
  }

  await page.getByTestId('recipe-tab').click()
  await expect(page.getByTestId('recipe-workflow')).toBeVisible()
  await page.getByLabel('Sample input mode').selectOption('mass')
  await page.getByTestId('recipe-sample-input').fill('100')
  await page.getByLabel('Sample concentration (ng/µL)').fill('50')
  await expect(page.getByTestId('recipe-evaluation')).toContainText('2.000 µL')
  await expect(page.getByTestId('recipe-evaluation')).toContainText('4.900 µL')

  await page.getByRole('button', { name: 'Plate layout' }).click()
  await page.getByTestId('samples-textarea').fill('Mouse-7\tcontrol\nMouse-7\ttreated')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()
  await page.getByTestId('plate-format-select').selectOption('96')
  const responsePromise = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
  await page.getByTestId('calculate-btn').click()
  expect((await responsePromise).status()).toBe(200)
  const idCells = page.locator('.layout-table tbody tr').filter({ hasText: 'Mouse-7' }).locator('td:nth-child(6)')
  await expect(idCells).toHaveCount(2)
  const sampleIds = await idCells.allTextContents()
  expect(sampleIds[0]).toMatch(/^exp-[^:]+:SAMPLE-00001$/)
  expect(sampleIds[1]).toMatch(/^exp-[^:]+:SAMPLE-00002$/)

  await page.getByTestId('plan-review-confirmation').check()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeEnabled()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('analysis-handoff-btn').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toContain('analysis-handoff.csv')
  const csvPath = await download.path()
  expect(csvPath).toBeTruthy()
  const csv = await readFile(csvPath!, 'utf8')
  expect(csv).toContain('"Well","Gene","Label","Cq","Plate","SampleId","Group","Type","Replicate"')
  expect(csv).toContain(sampleIds[0])
  expect(csv).toContain(sampleIds[1])

  await page.getByText('Saved experiments and packages').click()
  await page.getByTestId('package-name').fill('Mouse duplicate review')
  await page.getByTestId('save-local-package').click()
  await expect(page.getByRole('status')).toContainText('Saved “Mouse duplicate review”')

  const packageDownloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-package').click()
  const packageDownload = await packageDownloadPromise
  const packagePath = await packageDownload.path()
  const tamperedPackage = JSON.parse(await readFile(packagePath!, 'utf8'))
  tamperedPackage.settings.layout[0].Well = 'Z99'
  tamperedPackage.settings.layout[0].SampleId = 'tampered-sample-id'
  await page.getByTestId('import-package').setInputFiles({
    name: 'tampered.qpcr-planner.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(tamperedPackage)),
  })
  await expect(page.getByRole('status')).toContainText('recalculated its layout from the saved inputs')
  await expect(page.locator('.layout-table tbody tr').first().locator('td').first()).not.toHaveText('Z99')
  await expect(page.locator('.layout-table')).not.toContainText('tampered-sample-id')
  await expect(page.getByTestId('plan-review-confirmation')).not.toBeChecked()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeDisabled()

  await page.getByTestId('new-experiment').click()
  await expect(page.getByTestId('samples-textarea')).toHaveValue('')
  await expect(page.getByTestId('plate-format-select')).toHaveValue('96')
  await page.getByLabel('Saved local package').selectOption('Mouse duplicate review')
  await page.getByTestId('open-local-package').click()
  await expect(page.getByRole('status')).toContainText('recalculated its layout from the saved inputs')
  await expect(page.getByTestId('samples-textarea')).toHaveValue('Mouse-7\tcontrol\nMouse-7\ttreated')
  await expect(page.getByTestId('output-card')).toContainText('Per-plate wells, genes, and controls')
  await expect(page.getByTestId('plan-review-confirmation')).not.toBeChecked()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeDisabled()
})

test('recipe constraints keep the computed layout provisional and block final exports', async ({ page }) => {
  await page.goto(appBase)
  if (await page.getByTestId('setup-overlay').isVisible()) await page.getByTestId('setup-finish').click()
  await page.getByTestId('recipe-tab').click()
  await page.getByLabel('Limit source').fill('Kit instructions')
  await page.getByLabel('Maximum sample volume (µL)').fill('1')

  await page.getByRole('button', { name: 'Plate layout' }).click()
  await page.getByTestId('samples-textarea').fill('Mouse-1')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()
  const responsePromise = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
  await page.getByTestId('calculate-btn').click()
  expect((await responsePromise).status()).toBe(200)

  await expect(page.getByTestId('recipe-finalization-block')).toContainText('Sample volume exceeds the declared kit limit')
  await expect(page.getByTestId('plan-review-confirmation')).toBeDisabled()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeDisabled()
  await expect(page.getByTestId('output-copy-tsv-btn')).toBeDisabled()
  await expect(page.locator('.layout-table tbody tr')).not.toHaveCount(0)
})

test('editing or reordering sample rows rotates the SampleId namespace and clears review', async ({ page }) => {
  await page.goto(appBase)
  if (await page.getByTestId('setup-overlay').isVisible()) await page.getByTestId('setup-finish').click()
  await page.getByTestId('samples-textarea').fill('Mouse-1\tcontrol\nMouse-2\ttreated')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()
  const firstResponse = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
  await page.getByTestId('calculate-btn').click()
  expect((await firstResponse).status()).toBe(200)
  const firstSampleId = (await page.locator('.layout-table tbody tr').first().locator('td:nth-child(6)').textContent())?.trim() || ''
  const firstNamespace = firstSampleId.split(':')[0]
  expect(firstNamespace).toMatch(/^exp-/)

  await page.getByTestId('plan-review-confirmation').check()
  await page.getByTestId('samples-textarea').fill('Mouse-2\ttreated\nMouse-1\tcontrol')
  await expect(page.getByTestId('plan-review-confirmation')).not.toBeChecked()
  await expect(page.getByTestId('analysis-handoff-btn')).toBeDisabled()
  const secondResponse = page.waitForResponse((response) => response.url() === `${apiBase}/plan` && response.request().method() === 'POST')
  await page.getByTestId('calculate-btn').click()
  expect((await secondResponse).status()).toBe(200)
  const secondSampleId = (await page.locator('.layout-table tbody tr').first().locator('td:nth-child(6)').textContent())?.trim() || ''
  expect(secondSampleId.split(':')[0]).not.toBe(firstNamespace)
})
