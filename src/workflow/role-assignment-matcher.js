const DEFAULT_MIN_CONFIDENCE = 0.72
const DEFAULT_MIN_MARGIN = 0.08

export function matchRoleAssignments(role, assignments = [], options = {}) {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN
  const roleId = clean(role?.roleId || role?.id)
  const roleTitle = clean(role?.title || role?.roleTitle)
  const candidates = groupAssignments(assignments)

  if (!roleId && !roleTitle) return unmatchedResult()

  const idMatch = candidates.find((candidate) =>
    candidate.roleIds.some((candidateId) => candidateId === roleId)
  )
  if (roleId && idMatch) {
    return matchedResult(idMatch, 'job-id', 1)
  }

  const canonicalTitle = normalizeRoleTitle(roleTitle)
  const titleMatch = candidates.find((candidate) => candidate.normalizedTitle === canonicalTitle)
  if (canonicalTitle && titleMatch) {
    return matchedResult(titleMatch, 'title', 1)
  }

  if (!canonicalTitle) return unmatchedResult()

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      confidence: roleTitleSimilarity(canonicalTitle, candidate.normalizedTitle),
    }))
    .sort((left, right) =>
      right.confidence - left.confidence ||
      left.candidate.roleTitle.localeCompare(right.candidate.roleTitle)
    )
  const best = ranked[0]
  if (!best || best.confidence < minConfidence) return unmatchedResult(best?.confidence || 0)

  const runnerUp = ranked[1]
  if (runnerUp && best.confidence - runnerUp.confidence < minMargin) {
    return {
      ...unmatchedResult(best.confidence),
      matchType: 'ambiguous',
      candidates: ranked.slice(0, 3).map((item) => ({
        roleTitle: item.candidate.roleTitle,
        confidence: roundConfidence(item.confidence),
      })),
    }
  }

  return matchedResult(best.candidate, 'fuzzy', best.confidence)
}

export function normalizeRoleTitle(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—−]/g, '-')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/\band\b/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function roleTitleSimilarity(left, right) {
  const normalizedLeft = normalizeRoleTitle(left)
  const normalizedRight = normalizeRoleTitle(right)
  if (!normalizedLeft || !normalizedRight) return 0
  if (normalizedLeft === normalizedRight) return 1

  const tokenScore = diceCoefficient(
    new Set(normalizedLeft.split(' ')),
    new Set(normalizedRight.split(' ')),
  )
  const characterScore = levenshteinSimilarity(normalizedLeft, normalizedRight)
  return roundConfidence((tokenScore * 0.6) + (characterScore * 0.4))
}

function groupAssignments(assignments) {
  const groups = new Map()
  for (const assignment of assignments || []) {
    const roleTitle = clean(assignment?.roleTitle)
    const normalizedTitle = normalizeRoleTitle(roleTitle)
    const roleId = clean(assignment?.roleId)
    const key = roleId ? `id:${roleId}` : `title:${normalizedTitle}`
    if (!roleTitle && !roleId) continue

    const existing = groups.get(key) || {
      roleTitle,
      normalizedTitle,
      roleIds: [],
      assignments: [],
    }
    if (roleId && !existing.roleIds.includes(roleId)) existing.roleIds.push(roleId)
    existing.assignments.push(assignment)
    groups.set(key, existing)
  }
  return [...groups.values()]
}

function matchedResult(candidate, matchType, confidence) {
  return {
    assignments: candidate.assignments,
    matchType,
    matchedTitle: candidate.roleTitle,
    confidence: roundConfidence(confidence),
    candidates: [],
  }
}

function unmatchedResult(confidence = 0) {
  return {
    assignments: [],
    matchType: 'unmatched',
    matchedTitle: '',
    confidence: roundConfidence(confidence),
    candidates: [],
  }
}

function diceCoefficient(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const item of left) {
    if (right.has(item)) intersection += 1
  }
  return (2 * intersection) / (left.size + right.size)
}

function levenshteinSimilarity(left, right) {
  const maxLength = Math.max(left.length, right.length)
  if (maxLength === 0) return 1
  return 1 - (levenshteinDistance(left, right) / maxLength)
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]
    previous[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex]
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost,
      )
      diagonal = above
    }
  }
  return previous[right.length]
}

function roundConfidence(value) {
  return Math.round(Number(value || 0) * 1000) / 1000
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}
