import { test, expect } from '@playwright/test'
import { promises as fs } from 'fs'

test('qPCR planner flow', async ({ page }) => {
  await page.goto('/')
  await page.getByText('qPCR plate plans without guesswork').waitFor({ timeout: 60000 })

  await fs.mkdir('screenshots', { recursive: true })

  // Use a long pasted list so the run spans at least two plates
  const samples = Array.from({ length: 80 }, (_, i) => `Sample${i + 1}`).join('\n')
  const textarea = page.locator('textarea')
  await textarea.first().waitFor({ state: 'visible', timeout: 30000 })
  await textarea.fill(samples)

  // Initial plan view (before compute) + plan card
  await page.screenshot({ path: 'screenshots/plan_view.png', fullPage: true })
  const cards = page.locator('section.card')
  await cards.nth(0).screenshot({ path: 'screenshots/plan_tab.png' })
  await page.getByRole('button', { name: 'Plate preview' }).click()
  await page.locator('.plate-mini').screenshot({ path: 'screenshots/plate_preview.png' })

  await page.getByTestId('calculate-btn').click()
  // Confirm plan finished and spans multiple plates
  await expect(page.getByRole('cell', { name: 'Plate 1' }).first()).toBeVisible()
  const plateSelect = cards.nth(2).locator('select')
  await expect(plateSelect).toBeVisible()
  await plateSelect.selectOption({ label: 'Plate 2' })
  await expect(page.getByRole('cell', { name: 'Plate 2' }).first()).toBeVisible()

  // Full page after compute (layout + mix)
  await page.screenshot({ path: 'screenshots/layout_full.png', fullPage: true })
  await page.screenshot({ path: 'screenshots/example_run.png', fullPage: true })

  // Layout/output card
  await cards.nth(2).screenshot({ path: 'screenshots/output_tab.png' })

  // Master mix card
  const masterCard = cards.nth(3)
  await masterCard.screenshot({ path: 'screenshots/master_mix.png' })
  await masterCard.screenshot({ path: 'screenshots/master_tab.png' })

  // Notes card
  const notesCard = cards.nth(4)
  await notesCard.screenshot({ path: 'screenshots/notes_card.png' })
  await notesCard.screenshot({ path: 'screenshots/notes_tab.png' })
})
