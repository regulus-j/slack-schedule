export function normalizeJazzhrCandidate(record, index = 0) {
  const identity = candidateIdentity(record)
  const { jazzhrApplicationId, jazzhrJobId, candidateKey } = identity
  const firstName = String(record?.firstName || '').trim()
  const lastName = String(record?.lastName || '').trim()
  const fullName = String(record?.fullName || [firstName, lastName].filter(Boolean).join(' ') || '').replace(/\s+/g, ' ').trim()

  if (!jazzhrApplicationId || !fullName) return null

  return {
    id: `applicant-${candidateKey}`,
    candidateKey,
    jazzhrApplicationId,
    jazzhrJobId,
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
    .filter((record) => !candidateInactiveReason(record))
    .sort(compareJazzhrCandidates)
}

export function searchJazzhrCandidateRecords(records = [], query = '', { limit = 20, baseQuery = '' } = {}) {
  const normalizedQuery = normalizeSearchText(query)
  const normalizedBaseQuery = normalizeSearchText(baseQuery)
  return normalizeJazzhrCandidates(records)
    .filter((record) => {
      if (candidateInactiveReason(record)) return false
      const haystack = candidateSearchText(record)
      if (normalizedBaseQuery && !haystack.includes(normalizedBaseQuery)) return false
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false
      return true
    })
    .slice(0, limit)
}

export function candidateInactiveReason(record) {
  const statusValues = [
    record?.stage,
    record?.status,
    record?.applicantProgress,
    record?.applicant_progress,
    record?.disposition,
    record?.dispositionStatus,
    record?.disposition_status,
    record?.workflowStep,
    record?.workflow_step,
  ].filter(Boolean)

  for (const value of statusValues) {
    const normalized = normalizeSearchText(value).replace(/[_-]+/g, ' ')
    if (!normalized) continue
    if (INACTIVE_STATUS_KEYS.has(statusKey(normalized))) return `disposition:${normalized}`
    const term = INACTIVE_STATUS_TERMS.find((item) => normalized.includes(item))
    if (term) return term
  }

  return ''
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
    record.jazzhrJobId,
    record.candidateKey,
  ].filter(Boolean).join(' '))
}

function candidateIdentity(record) {
  const rawId = String(record?.jazzhrApplicationId || record?.id || '').replace(/^applicant-/, '').trim()
  const [idApplicantPart, idJobPart = ''] = rawId.split('::')
  const jazzhrApplicationId = idApplicantPart
  const jazzhrJobId = String(record?.jazzhrJobId || record?.jobId || record?.job_id || idJobPart || '').trim()
  const rawCandidateKey = String(record?.candidateKey || '').replace(/^applicant-/, '').trim()
  const candidateKey = rawCandidateKey || [jazzhrApplicationId, jazzhrJobId].filter(Boolean).join('::')
  return { jazzhrApplicationId, jazzhrJobId, candidateKey }
}

function normalizeSearchText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function dateSortValue(value) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function statusKey(value) {
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g, '')
}

const INACTIVE_STATUS_TERMS = [
  'rejected',
  'reject',
  'declined',
  'decline',
  'withdrawn',
  'withdraw',
  'hired',
  'archived',
  'deleted',
  'closed',
  'unresponsive',
  'black listed',
  'blacklisted',
  'offboarded',
]

const INACTIVE_STATUS_KEYS = new Set([
  '1stinterviewrejectedbyrecruiter',
  'resumescreeningrejectedbyrecruiter',
  '2ndorfinalinterviewrejectedbyhiringmanager',
  'rejectedduetofailedassessment',
  'blacklistedandnotculturefit',
  'outofthehiringarea',
  'outofsydneyaustralia',
  'withdrewapplication',
  'autorejectionduelackofexperience',
  'autorejectionoutofthehiringarea',
  'missedinterview',
  'unresponsive',
  'goodforfuturehire',
  'endorsedtoanotherrole',
  'declinedjoboffer',
  'failedtrialperiodrejectedbyhm',
  'offboarded',
])
