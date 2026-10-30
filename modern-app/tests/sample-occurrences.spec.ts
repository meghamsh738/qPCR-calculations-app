import { test, expect } from '@playwright/test'

const samples = ['Mouse-7\tcontrol\tHPC', 'Mouse-7\ttreated\tHYP', 'Mouse-7\tcontrol\tHPC']
const sampleNumbers = [1, 1, 2, 2, 3, 3]
const payload = {
  use_pasted_samples: true,
  pasted_samples: samples,
  num_standards: 0,
  num_pos: 0,
  replicates: 2,
  overage_pct: 10,
  include_rtneg: false,
  include_rnaneg: false,
  genes: [{ name: 'Reference', chemistry: 'SYBR' }, { name: 'Target', chemistry: 'TaqMan' }],
}

for (const primer_source of ['working', 'stock']) {
  test(`repeated entries retain their identity across chemistries with ${primer_source} primers`, async ({ request }) => {
    const response = await request.post('http://127.0.0.1:8003/plan', { data: { ...payload, primer_source } })
    expect(response.status()).toBe(200)
    const plan = await response.json()
    expect(plan.summary).toHaveLength(2)
    for (const gene of payload.genes) {
      const rows = plan.layout.filter((row: { Gene: string; Type: string }) => row.Gene === gene.name && row.Type === 'Sample')
      expect(rows.map((row: { SampleIndex: number }) => row.SampleIndex)).toEqual(sampleNumbers)
      expect(rows.map((row: { Label: string }) => row.Label)).toEqual(Array(6).fill('Mouse-7'))
      expect(rows.map((row: { Extras: string[] }) => row.Extras)).toEqual([
        ['control', 'HPC'], ['control', 'HPC'], ['treated', 'HYP'], ['treated', 'HYP'], ['control', 'HPC'], ['control', 'HPC'],
      ])
      const mix = plan.mix.find((row: { Gene: string }) => row.Gene === gene.name)
      expect(mix.placed_reactions).toBe(8) // Three sample entries plus a blank, each in duplicate.
      expect(mix.primer_concentration_uM).toBe(primer_source === 'stock' ? 100 : 10)
      expect(mix.fwd_primer_ul).toBeCloseTo((primer_source === 'stock' ? 0.03 : 0.3) * 8.8)
    }
    const wellIds = plan.layout.map((row: { Plate: string; Well: string }) => `${row.Plate}/${row.Well}`)
    expect(new Set(wellIds).size).toBe(wellIds.length)
  })
}

test('table and copied TSV distinguish identical labels and preserve input order', async ({ page }) => {
  await page.goto('/')
  if (await page.getByTestId('setup-overlay').isVisible()) await page.getByTestId('setup-finish').click()
  await page.getByTestId('samples-textarea').fill(samples.join('\n'))
  await page.getByTestId('standards-input').fill('0')
  await page.getByLabel('Replicates', { exact: true }).fill('2')
  await page.getByLabel('Include RT−', { exact: true }).uncheck()
  await page.getByLabel('Include RNA−', { exact: true }).uncheck()
  await page.getByRole('combobox', { name: 'Primer solution' }).selectOption('stock')
  const calculated = page.waitForResponse(r => r.url().endsWith('/plan') && r.request().method() === 'POST')
  await page.getByTestId('calculate-btn').click()
  expect((await calculated).status()).toBe(200)
  const table = page.locator('.layout-table')
  await expect(table.getByRole('columnheader', { name: 'Sample #', exact: true })).toBeVisible()
  const rows = table.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Mouse-7', exact: true }) })
  await expect(rows).toHaveCount(6)
  expect(await rows.evaluateAll(elements => elements.map(row => row.querySelectorAll('td')[4].textContent))).toEqual(sampleNumbers.map(String))
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { Object.assign(window, { copiedLayout: text }) },
  } }))
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('output-copy-tsv-btn').click()
  const tsv = await page.evaluate(() => (window as Window & { copiedLayout: string }).copiedLayout)
  const [headers, ...data] = tsv.split('\n').map(line => line.split('\t'))
  expect(headers).toEqual(['Well', 'Gene', 'Type', 'Label', 'Sample #', 'Extra 1', 'Extra 2', 'Replicate', 'Plate'])
  const firstGene = data[0][1]
  expect(data.filter(row => row[1] === firstGene && row[2] === 'Sample').map(row => row[4])).toEqual(sampleNumbers.map(String))
  expect(data.filter(row => row[2] === 'Blank').every(row => row[4] === '')).toBe(true)

  // A denied clipboard write must not claim success or discard the calculated plan.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: {
    writeText: async () => { throw new Error('Clipboard denied') },
  } }))
  await page.getByTestId('output-copy-tsv-btn').click()
  await expect(page.getByText('Could not copy the layout. Allow clipboard access and try again.')).toBeVisible()
  await expect(rows).toHaveCount(6)
})
