import { test, expect } from '@playwright/test'

const apiUrl = 'http://127.0.0.1:8003/plan'
const planInputs = {
  num_samples: 4,
  num_standards: 0,
  num_pos: 0,
  replicates: 2,
  overage_pct: 10,
  include_rtneg: false,
  include_rnaneg: false,
  genes: [{ name: 'Target', chemistry: 'SYBR' }],
}

for (const chemistry of ['SYBR', 'TaqMan']) {
  test(`API preserves primer dose and reaction volume for ${chemistry}`, async ({ request }) => {
    const payload = { ...planInputs, genes: [{ name: 'Target', chemistry }] }
    const workingResponse = await request.post(apiUrl, { data: { ...payload, primer_source: 'working' } })
    const stockResponse = await request.post(apiUrl, { data: { ...payload, primer_source: 'stock' } })
    expect(workingResponse.status()).toBe(200)
    expect(stockResponse.status()).toBe(200)
    const workingPlan = await workingResponse.json()
    const stockPlan = await stockResponse.json()
    expect(stockPlan.layout).toEqual(workingPlan.layout)
    expect(stockPlan.summary).toEqual(workingPlan.summary)

    for (const [source, plan] of [['working', workingPlan], ['stock', stockPlan]] as const) {
      const mix = plan.mix[0]
      const concentration = source === 'stock' ? 100 : 10
      const primerPerReaction = source === 'stock' ? 0.03 : 0.3
      const waterPerReaction = (chemistry === 'SYBR' ? 4.9 : 4.6) + (source === 'stock' ? 0.54 : 0)
      expect(plan.inputs.primer_source).toBe(source)
      expect(mix.primer_concentration_uM).toBe(concentration)
      // Four samples plus one blank, each in duplicate, with 10% overage.
      expect(mix.placed_reactions).toBe(10)
      expect(mix.mix_equiv_rxn).toBeCloseTo(11)
      expect(mix.fwd_primer_ul).toBeCloseTo(primerPerReaction * 11)
      expect(mix.rev_primer_ul).toBeCloseTo(primerPerReaction * 11)
      expect(mix.rna_free_h2o).toBeCloseTo(waterPerReaction * 11)
      expect(mix.master_mix_2x).toBeCloseTo(7.5 * 11)
      expect(mix.probe_10uM).toBeCloseTo((chemistry === 'TaqMan' ? 0.3 : 0) * 11)
      // 3 pmol of each primer in a 15 µL reaction gives the existing 0.2 µM dose.
      expect(mix.fwd_primer_ul / 11 * concentration / 15).toBeCloseTo(0.2)
      expect(mix.rev_primer_ul / 11 * concentration / 15).toBeCloseTo(0.2)
      const totalMix = mix.master_mix_2x + mix.rna_free_h2o + mix.probe_10uM + mix.fwd_primer_ul + mix.rev_primer_ul
      expect(totalMix).toBeCloseTo(13 * 11)
    }
  })
}

test('API defaults to working primers and rejects unknown primer sources', async ({ request }) => {
  const defaultResponse = await request.post(apiUrl, { data: planInputs })
  expect(defaultResponse.status()).toBe(200)
  const defaultPlan = await defaultResponse.json()
  expect(defaultPlan.inputs.primer_source).toBe('working')
  expect(defaultPlan.mix[0].primer_concentration_uM).toBe(10)
  expect(defaultPlan.mix[0].fwd_primer_ul).toBeCloseTo(3.3)

  for (const primer_source of ['unknown', '', null, 100]) {
    const invalidResponse = await request.post(apiUrl, { data: { ...planInputs, primer_source } })
    expect(invalidResponse.status()).toBe(422)
  }
})

test('primer selector updates computed concentrations and displayed volumes', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/')
  await expect(page).toHaveURL('http://localhost:5176/')
  await expect(page).toHaveTitle('modern-app')
  await expect(page.getByRole('heading', { name: 'qPCR plate plans without guesswork' })).toBeVisible()
  if (await page.getByTestId('setup-overlay').isVisible()) {
    await page.getByTestId('setup-finish').click()
  }
  await page.getByTestId('samples-textarea').fill('Sample1\nSample2')
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('1')
  await page.getByLabel('Mix overage (%)', { exact: true }).fill('0')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()

  const selector = page.getByRole('combobox', { name: 'Primer solution' })
  await expect(selector).toHaveValue('working')
  const masterCard = page.getByTestId('master-card')
  const sybrRow = masterCard.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Ccl2', exact: true }) })
  const taqRow = masterCard.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Tnf', exact: true }) })

  for (const source of ['working', 'stock', 'working']) {
    await selector.selectOption(source)
    if (source === 'stock') {
      // Existing results keep their calculated concentration until recomputed.
      await expect(page.getByTestId('mix-primer-concentration')).toHaveText('Forward and reverse primer solution: 10 µM.')
    }
    const responsePromise = page.waitForResponse(response => response.url() === apiUrl && response.request().method() === 'POST')
    await page.getByTestId('calculate-btn').click()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON().primer_source).toBe(source)
    const concentration = source === 'stock' ? 100 : 10
    await expect(page.getByTestId('mix-primer-concentration')).toHaveText(`Forward and reverse primer solution: ${concentration} µM.`)
    await expect(sybrRow.getByRole('cell')).toHaveText([
      'Ccl2', 'SYBR', '3', '1.00', '3.0', '22.5', source === 'stock' ? '16.32' : '14.70', '0.00',
      source === 'stock' ? '0.09' : '0.90', source === 'stock' ? '0.09' : '0.90',
    ])
    await expect(taqRow.getByRole('cell')).toHaveText([
      'Tnf', 'TaqMan', '3', '1.00', '3.0', '22.5', source === 'stock' ? '15.42' : '13.80', '0.90',
      source === 'stock' ? '0.09' : '0.90', source === 'stock' ? '0.09' : '0.90',
    ])
    await masterCard.screenshot({ path: testInfo.outputPath(`${source}-primers.png`) })
    if (source === 'stock') {
      await page.getByTestId('genes-card').screenshot({ path: testInfo.outputPath('stock-selector.png') })
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await selector.selectOption('stock')
  const mobileResponsePromise = page.waitForResponse(response => response.url() === apiUrl && response.request().method() === 'POST')
  await page.getByTestId('calculate-btn').click()
  expect((await mobileResponsePromise).status()).toBe(200)
  await expect(page.getByTestId('mix-primer-concentration')).toHaveText('Forward and reverse primer solution: 100 µM.')
  await page.getByTestId('genes-card').screenshot({ path: testInfo.outputPath('mobile-selector.png') })
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  expect(errors).toEqual([])
})
