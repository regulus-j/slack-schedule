import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STAGE_RULES,
  STAGE_OPTIONS,
  normalizeStageKey,
  resolveStageFromTemplate,
  resolveStageRules,
  resolveTemplateFromStage,
} from '../src/workflow/stage-rules.js'

test('DEFAULT_STAGE_RULES has three stages', () => {
  const keys = Object.keys(DEFAULT_STAGE_RULES)
  assert.equal(keys.length, 3)
  assert.ok(keys.includes('1st-interview'))
  assert.ok(keys.includes('2nd-interview'))
  assert.ok(keys.includes('final-interview'))
})

test('STAGE_OPTIONS exposes exactly the intake stage choices', () => {
  assert.deepEqual(STAGE_OPTIONS.map((stage) => stage.label), ['1st Interview', '2nd Interview', 'Final Interview'])
})

test('DEFAULT_STAGE_RULES 1st-interview has correct defaults', () => {
  const rules = DEFAULT_STAGE_RULES['1st-interview']
  assert.equal(rules.hiringManagerRequired, false)
  assert.equal(rules.hiringManagerDefault, 'excluded')
  assert.equal(rules.typicalDurationMinutes, 30)
  assert.equal(rules.bufferMinutes, 15)
  assert.equal(rules.maxInterviewers, 2)
})

test('DEFAULT_STAGE_RULES 2nd-interview has correct defaults', () => {
  const rules = DEFAULT_STAGE_RULES['2nd-interview']
  assert.equal(rules.hiringManagerRequired, true)
  assert.equal(rules.hiringManagerDefault, 'included')
  assert.equal(rules.typicalDurationMinutes, 45)
})

test('DEFAULT_STAGE_RULES final-interview has correct defaults', () => {
  const rules = DEFAULT_STAGE_RULES['final-interview']
  assert.equal(rules.hiringManagerRequired, true)
  assert.equal(rules.hiringManagerDefault, 'included')
  assert.equal(rules.typicalDurationMinutes, 45)
})

test('resolveStageFromTemplate returns 1st-interview for 1st-interview-invite', () => {
  const result = resolveStageFromTemplate('1st-interview-invite')
  assert.equal(result, '1st-interview')
})

test('resolveStageFromTemplate returns 2nd-interview for 2nd-or-Final-invite', () => {
  const result = resolveStageFromTemplate('2nd-or-Final-invite')
  assert.equal(result, '2nd-interview')
})

test('resolveStageFromTemplate returns 2nd-interview for Thank You Email template', () => {
  const result = resolveStageFromTemplate('Thank You Email - 2nd-or-Final Interview')
  assert.equal(result, '2nd-interview')
})

test('resolveTemplateFromStage maps intake stages to invite templates', () => {
  assert.equal(resolveTemplateFromStage('1st-interview'), '1st-interview-invite')
  assert.equal(resolveTemplateFromStage('2nd-interview'), '2nd-or-Final-invite')
  assert.equal(resolveTemplateFromStage('final-interview'), '2nd-or-Final-invite')
})

test('normalizeStageKey keeps compatibility aliases', () => {
  assert.equal(normalizeStageKey('2nd-or-final'), '2nd-interview')
  assert.equal(normalizeStageKey('final-offer'), 'final-interview')
})

test('resolveStageFromTemplate returns null for unknown template', () => {
  const result = resolveStageFromTemplate('nonexistent-template')
  assert.equal(result, null)
})

test('resolveStageFromTemplate returns null for reminder templates', () => {
  assert.equal(resolveStageFromTemplate('interview-reminder'), null)
  assert.equal(resolveStageFromTemplate('interview-reminder (unresponsive candidate)'), null)
})

test('resolveStageRules uses default when no overrides', () => {
  const result = resolveStageRules('1st-interview')
  assert.equal(result.hiringManagerRequired, false)
  assert.equal(result.hiringManagerDefault, 'excluded')
  assert.equal(result.typicalDurationMinutes, 30)
  assert.equal(result.bufferMinutes, 15)
  assert.equal(result.maxInterviewers, 2)
})

test('resolveStageRules applies overrides without mutating defaults', () => {
  const original = structuredClone(DEFAULT_STAGE_RULES['1st-interview'])
  const result = resolveStageRules('1st-interview', { hiringManagerRequired: true })
  assert.equal(result.hiringManagerRequired, true)
  assert.equal(DEFAULT_STAGE_RULES['1st-interview'].hiringManagerRequired, false)
  assert.deepEqual(DEFAULT_STAGE_RULES['1st-interview'], original)
})

test('resolveStageRules resolves durationMinutes override', () => {
  const result = resolveStageRules('1st-interview', { durationMinutes: 60 })
  assert.equal(result.typicalDurationMinutes, 60)
})

test('resolveStageRules resolves hiringManagerRequired override', () => {
  const result = resolveStageRules('2nd-or-final', { hiringManagerRequired: false })
  assert.equal(result.hiringManagerRequired, false)
})

test('resolveStageRules resolves hiringManagerDefault override', () => {
  const result = resolveStageRules('1st-interview', { hiringManagerDefault: 'included' })
  assert.equal(result.hiringManagerDefault, 'included')
})

test('resolveStageRules resolves bufferMinutes override', () => {
  const result = resolveStageRules('1st-interview', { bufferMinutes: 30 })
  assert.equal(result.bufferMinutes, 30)
})

test('resolveStageRules resolves maxInterviewers override', () => {
  const result = resolveStageRules('1st-interview', { maxInterviewers: 5 })
  assert.equal(result.maxInterviewers, 5)
})

test('resolveStageRules falls back to 1st-interview for unknown stage', () => {
  const result = resolveStageRules('nonexistent-stage')
  assert.equal(result.hiringManagerDefault, 'excluded')
  assert.equal(result.typicalDurationMinutes, 30)
})

test('resolveStageRules handles overrides on unknown stage', () => {
  const result = resolveStageRules('nonexistent-stage', { durationMinutes: 20 })
  assert.equal(result.typicalDurationMinutes, 20)
})
