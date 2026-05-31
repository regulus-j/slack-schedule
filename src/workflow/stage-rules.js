import { TEMPLATE_METADATA } from '../templates.js'

export const DEFAULT_STAGE_RULES = {
  '1st-interview': {
    typicalDurationMinutes: 30,
    bufferMinutes: 15,
    description: '1st Interview'
  },
  '2nd-interview': {
    typicalDurationMinutes: 45,
    bufferMinutes: 15,
    description: '2nd Interview'
  },
  'final-interview': {
    typicalDurationMinutes: 45,
    bufferMinutes: 15,
    description: 'Final Interview'
  },
  'job-offer-discussion': {
    typicalDurationMinutes: 45,
    bufferMinutes: 15,
    description: 'Job Offer Discussion'
  }
}

export const STAGE_OPTIONS = [
  { key: '1st-interview', label: '1st Interview', templateId: '1st-interview-invite' },
  { key: '2nd-interview', label: '2nd Interview', templateId: '2nd-or-Final-invite' },
  { key: 'final-interview', label: 'Final Interview', templateId: '2nd-or-Final-invite' },
  { key: 'job-offer-discussion', label: 'Job Offer Discussion', templateId: 'job-offer-discussion' },
]

const STAGE_ALIASES = {
  '2nd-or-final': '2nd-interview',
  'final-offer': 'job-offer-discussion',
  'job-offer': 'job-offer-discussion'
}

const TEMPLATE_TO_STAGE = {
  '1st-interview-invite': '1st-interview',
  '2nd-or-Final-invite': '2nd-interview',
  'job-offer-discussion': 'job-offer-discussion',
  'Thank You Email - 2nd-or-Final Interview': '2nd-interview',
  'interview-reminder': null,
  'interview-reminder (unresponsive candidate)': null
}

export function normalizeStageKey(stageKey) {
  return STAGE_ALIASES[stageKey] || stageKey || ''
}

export function resolveStageFromTemplate(templateId) {
  if (templateId in TEMPLATE_TO_STAGE) return TEMPLATE_TO_STAGE[templateId]
  const meta = TEMPLATE_METADATA[templateId]
  if (!meta) return null
  if (meta.interviewStage === '1st Interview') return '1st-interview'
  if (meta.interviewStage === '2nd/Final Interview') return '2nd-interview'
  if (meta.interviewStage === 'Job Offer Discussion') return 'job-offer-discussion'
  return null
}

export function resolveTemplateFromStage(stageKey) {
  const normalized = normalizeStageKey(stageKey)
  return STAGE_OPTIONS.find((stage) => stage.key === normalized)?.templateId || ''
}

export function stageLabel(stageKey) {
  const normalized = normalizeStageKey(stageKey)
  return STAGE_OPTIONS.find((stage) => stage.key === normalized)?.label || 'Interview'
}

export function resolveStageRules(stageKey, stageOverrides = {}) {
  const normalized = normalizeStageKey(stageKey)
  const defaults = DEFAULT_STAGE_RULES[normalized] || DEFAULT_STAGE_RULES['1st-interview']
  const base = structuredClone(defaults)
  if (stageOverrides.typicalDurationMinutes !== undefined) base.typicalDurationMinutes = stageOverrides.typicalDurationMinutes
  if (stageOverrides.durationMinutes !== undefined) base.typicalDurationMinutes = stageOverrides.durationMinutes
  if (stageOverrides.bufferMinutes !== undefined) base.bufferMinutes = stageOverrides.bufferMinutes
  return base
}
