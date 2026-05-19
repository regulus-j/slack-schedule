import { TEMPLATE_METADATA } from '../templates.js'

export const DEFAULT_STAGE_RULES = {
  '1st-interview': {
    hiringManagerRequired: false,
    hiringManagerDefault: 'excluded',
    typicalDurationMinutes: 30,
    bufferMinutes: 15,
    maxInterviewers: 2,
    description: 'First Interview'
  },
  '2nd-or-final': {
    hiringManagerRequired: true,
    hiringManagerDefault: 'included',
    typicalDurationMinutes: 45,
    bufferMinutes: 15,
    maxInterviewers: 3,
    description: 'Second / Final Interview'
  },
  'final-offer': {
    hiringManagerRequired: false,
    hiringManagerDefault: 'optional',
    typicalDurationMinutes: 30,
    bufferMinutes: 15,
    maxInterviewers: 2,
    description: 'Final Job Offer Meeting'
  }
}

const TEMPLATE_TO_STAGE = {
  '1st-interview-invite': '1st-interview',
  '2nd-or-Final-invite': '2nd-or-final',
  'Thank You Email - 2nd-or-Final Interview': '2nd-or-final',
  'interview-reminder': null,
  'interview-reminder (unresponsive candidate)': null
}

export function resolveStageFromTemplate(templateId) {
  if (templateId in TEMPLATE_TO_STAGE) return TEMPLATE_TO_STAGE[templateId]
  const meta = TEMPLATE_METADATA[templateId]
  if (!meta) return null
  if (meta.interviewStage === '1st Interview') return '1st-interview'
  if (meta.interviewStage === '2nd/Final Interview') return '2nd-or-final'
  return null
}

export function resolveStageRules(stageKey, stageOverrides = {}) {
  const defaults = DEFAULT_STAGE_RULES[stageKey] || DEFAULT_STAGE_RULES['1st-interview']
  const base = structuredClone(defaults)
  if (stageOverrides.hiringManagerRequired !== undefined) base.hiringManagerRequired = stageOverrides.hiringManagerRequired
  if (stageOverrides.hiringManagerDefault !== undefined) base.hiringManagerDefault = stageOverrides.hiringManagerDefault
  if (stageOverrides.typicalDurationMinutes !== undefined) base.typicalDurationMinutes = stageOverrides.typicalDurationMinutes
  if (stageOverrides.durationMinutes !== undefined) base.typicalDurationMinutes = stageOverrides.durationMinutes
  if (stageOverrides.bufferMinutes !== undefined) base.bufferMinutes = stageOverrides.bufferMinutes
  if (stageOverrides.maxInterviewers !== undefined) base.maxInterviewers = stageOverrides.maxInterviewers
  return base
}
