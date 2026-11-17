type ReviewedSample = {
  label: string
  sourceRow: number
  reason: string
  ready: boolean
}

export type CdnaHandoff = {
  name: string
  revision: number
  samples: ReviewedSample[]
}

export async function readCdnaHandoff(file: File): Promise<CdnaHandoff> {
  if (file.size > 100_000_000) throw Error('Use a cDNA package smaller than 100 MB.')
  const envelope = JSON.parse(await file.text())
  const payload = envelope?.payload
  if (
    envelope?.format !== 'easylab.cdna' || envelope.version !== 1
    || payload?.engine !== 'next-cdna-1' || !Array.isArray(payload.result?.rows)
  ) {
    throw Error('Choose a saved EasyLab Next cDNA experiment package.')
  }
  if (!crypto.subtle) throw Error('Open the isolated local Planner to verify this package.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)))
  const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (checksum !== envelope.checksum) throw Error('The cDNA package has changed since it was saved.')

  const experiment = payload.experiment
  if (experiment?.reviewed !== true || payload.result.ready !== true) {
    throw Error('Review the preparation in cDNA Calculator and save a new package first.')
  }
  if (typeof experiment.name !== 'string' || !Number.isSafeInteger(experiment.revision)) {
    throw Error('The saved cDNA name or revision is invalid.')
  }

  const samples: ReviewedSample[] = payload.result.rows.map((row: unknown) => {
    if (!row || typeof row !== 'object' || !('sample' in row) || typeof row.sample !== 'string'
      || !('source_row' in row) || typeof row.source_row !== 'number' || !Number.isSafeInteger(row.source_row)) {
      throw Error('The cDNA package contains an invalid sample row.')
    }
    const ready = 'status' in row && row.status === 'ready' && 'feasible' in row && row.feasible === true
      && 'excluded' in row && row.excluded === false
    const label = row.sample.trim()
    if (ready && (!label || /^[#]/.test(label) || /[\t\r\n]/.test(label))) {
      throw Error(`cDNA row ${row.source_row} needs a sample label without an initial #, tabs or line breaks.`)
    }
    const reason = 'exclusion_reason' in row && typeof row.exclusion_reason === 'string' ? row.exclusion_reason : ''
    return { label, sourceRow: row.source_row, ready, reason }
  })
  if (!samples.some(sample => sample.ready)) throw Error('The reviewed cDNA package has no ready samples.')
  return { name: experiment.name, revision: experiment.revision, samples }
}

export function cdnaSampleLines(handoff: CdnaHandoff): string {
  // With an explicit empty Group column, the Planner preserves spaces and commas in labels.
  return handoff.samples.filter(sample => sample.ready).map(sample => `${sample.label}\t`).join('\n')
}
