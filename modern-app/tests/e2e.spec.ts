import { test, expect } from '@playwright/test'

test('qPCR planner flow', async ({ page }) => {
  await page.goto('/')
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' })
  await page.getByText('qPCR plate plans without guesswork').waitFor({ timeout: 60000 })

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

test('pasted samples keep extra columns in output table', async ({ page }) => {
  await page.goto('/')
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' })
  await page.getByText('qPCR plate plans without guesswork').waitFor({ timeout: 60000 })

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
