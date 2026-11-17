import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readCdnaHandoff, cdnaSampleLines } from '../src/cdnaHandoff.ts'

const sample = (row, label, ready) => ({
  source_row: row, sample: label, feasible: ready, excluded: !ready, status: ready ? 'ready' : 'excluded',
  exclusion_reason: ready ? '' : 'No usable stock',
})
const savedExperiment = (reviewed = true) => {
  const payload = {
    engine: 'next-cdna-1',
    experiment: { name: 'Fictional preparation', revision: 3, reviewed },
    result: { ready: true, rows: [sample(2, 'Sample A, repeat', true), sample(3, 'Sample A, repeat', true), sample(4, 'Sample C', false)] },
  }
  return JSON.stringify({
    format: 'easylab.cdna', version: 1, payload,
    checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  })
}
const file = content => new File([content], 'fictional.easylab.json')

test('reviewed import retains the complete preview and carries only ready occurrences', async () => {
  const handoff = await readCdnaHandoff(file(savedExperiment()))
  assert.equal(handoff.samples.length, 3)
  assert.equal(handoff.samples[2].reason, 'No usable stock')
  assert.equal(handoff.revision, 3)
  assert.equal(cdnaSampleLines(handoff), 'Sample A, repeat\t\nSample A, repeat\t')
})

test('unreviewed or modified preparation cannot be applied', async () => {
  await assert.rejects(readCdnaHandoff(file(savedExperiment(false))), /Review the preparation/)
  await assert.rejects(readCdnaHandoff(file(savedExperiment().replace('Sample A, repeat', 'Changed label'))), /has changed/)
})
