export function normalizeJazzhrCandidate(record, index = 0) {
  const jazzhrApplicationId = String(record?.jazzhrApplicationId || record?.id || '').replace(/^applicant-/, '')
  const firstName = String(record?.firstName || '').trim()
  const lastName = String(record?.lastName || '').trim()
  const fullName = String(record?.fullName || [firstName, lastName].filter(Boolean).join(' ') || '').replace(/\s+/g, ' ').trim()

  if (!jazzhrApplicationId || !fullName) return null

  return {
    id: `applicant-${jazzhrApplicationId}`,
    jazzhrApplicationId,
    fullName,
    firstName,
    lastName,
    email: String(record?.email || '').trim(),
    phone: String(record?.phone || '').trim(),
    jobTitle: String(record?.jobTitle || '').trim(),
    stage: String(record?.stage || '').trim(),
    recruiterId: String(record?.recruiterId || '').trim(),
    source: record?.source || 'jazzhr',
    appliedAt: String(record?.appliedAt || record?.applyDate || '').trim(),
    sourceOrder: Number.isFinite(Number(record?.sourceOrder)) ? Number(record.sourceOrder) : index,
  }
}

export function normalizeJazzhrCandidates(records = []) {
  return (Array.isArray(records) ? records : [])
    .map((record, index) => normalizeJazzhrCandidate(record, index))
    .filter(Boolean)
    .sort(compareJazzhrCandidates)
}

export function searchJazzhrCandidateRecords(records = [], query = '', { limit = 20, baseQuery = '' } = {}) {
  const normalizedQuery = normalizeSearchText(query)
  const normalizedBaseQuery = normalizeSearchText(baseQuery)
  return normalizeJazzhrCandidates(records)
    .filter((record) => {
      const haystack = candidateSearchText(record)
      if (normalizedBaseQuery && !haystack.includes(normalizedBaseQuery)) return false
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false
      return true
    })
    .slice(0, limit)
}

export function compareJazzhrCandidates(left, right) {
  const leftDate = dateSortValue(left.appliedAt)
  const rightDate = dateSortValue(right.appliedAt)
  if (leftDate !== rightDate) return rightDate - leftDate
  if (left.sourceOrder !== right.sourceOrder) return left.sourceOrder - right.sourceOrder
  return left.fullName.localeCompare(right.fullName)
}

function candidateSearchText(record) {
  return normalizeSearchText([
    record.fullName,
    record.firstName,
    record.lastName,
    record.email,
    record.jobTitle,
    record.jazzhrApplicationId,
  ].filter(Boolean).join(' '))
}

function normalizeSearchText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function dateSortValue(value) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}
