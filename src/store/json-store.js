import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decryptJson, encryptJson } from '../security/crypto.js';
import { normalizeJazzhrCandidates, searchJazzhrCandidateRecords } from './candidate-index.js';

const DEFAULT_STATE = {
  cases: [],
  audits: [],
  googleTokens: {},
  oauthStates: {},
  rateLimits: {},
  candidateSeenAt: {},
  jazzhrCandidates: [],
  notificationJobs: [],
};

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeCase(record) {
  if (!record) return record
  return {
    ...record,
    approvals: normalizeArray(record.approvals),
    guests: normalizeArray(record.guests),
    scheduleHistory: normalizeArray(record.scheduleHistory),
    attendees: normalizeArray(record.attendees),
    externalAttendees: normalizeArray(record.externalAttendees),
    customInvite: record.customInvite && typeof record.customInvite === 'object' ? record.customInvite : null,
  }
}

export function createJsonStore(runtimeDir, cipher = '') {
  const statePath = path.join(runtimeDir, 'state.json');
  const backupPath = path.join(runtimeDir, 'state.json.bak')
  let state = structuredClone(DEFAULT_STATE);
  const tokenCipher = normalizeCipher(cipher)

  // Debounced persistence: mutations mark state dirty and schedule an async
  // flush. The flush runs on a setTimeout so it yields to the event loop,
  // preventing large JSON.stringify calls from blocking Slack interactions.
  const WRITE_DEBOUNCE_MS = 200
  let _dirty = false
  let _flushTimer = null
  let _flushPromise = null

  // Marks state as dirty and schedules a deferred write. Resolves immediately
  // so callers never wait for disk I/O on the critical path.
  async function persist() {
    _dirty = true
    scheduleFlush()
  }

  function scheduleFlush() {
    if (_flushTimer || _flushPromise) return
    _flushTimer = setTimeout(flush, WRITE_DEBOUNCE_MS)
  }

  async function flush() {
    _flushTimer = null
    _flushPromise = (async () => {
      if (!_dirty) return
      _dirty = false
      try {
        await fs.mkdir(runtimeDir, { recursive: true })
        const payload = JSON.stringify(state, null, 2)
        await writeFileAtomically(statePath, payload)
        await writeFileAtomically(backupPath, payload)
      } catch (error) {
        // Log but never propagate — in-memory state is already correct.
        // JSON store is dev/local; disk failures should not crash the app.
        console.error('json_store_write_failed', error.message)
      }
    })()
    await _flushPromise
    _flushPromise = null
    // If more mutations arrived during the flush, schedule another
    if (_dirty) scheduleFlush()
  }

  function loadStateFromRaw(raw) {
    state = normalizeLoadedState(JSON.parse(raw))
  }

  async function recoverFromBackup(parseError) {
    try {
      const backupRaw = await fs.readFile(backupPath, 'utf8')
      loadStateFromRaw(backupRaw)
    } catch (backupError) {
      throw new Error(
        `Cannot parse JSON store at ${statePath}: ${parseError.message}. ` +
        `No valid backup could be loaded from ${backupPath}: ${backupError.message}`,
      )
    }

    await preserveCorruptStateFile()
    await persist()
    await flush()
  }

  async function preserveCorruptStateFile() {
    const corruptPath = path.join(
      runtimeDir,
      `state.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    try {
      await fs.rename(statePath, corruptPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  return {
    async init() {
      await fs.mkdir(runtimeDir, { recursive: true });
      try {
        const raw = await fs.readFile(statePath, 'utf8');
        loadStateFromRaw(raw)
        await writeFileAtomically(backupPath, JSON.stringify(state, null, 2))
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        if (error instanceof SyntaxError) {
          await recoverFromBackup(error)
          return
        }
        // First-time init: write the initial empty state directly so the
        // file exists on disk before init resolves. Don't use persist()
        // here — it's debounced and the file might not exist yet.
        await fs.mkdir(runtimeDir, { recursive: true })
        await writeFileAtomically(statePath, JSON.stringify(state, null, 2))
        await writeFileAtomically(backupPath, JSON.stringify(state, null, 2))
      }
    },

    async stats() {
      return { cases: state.cases.length, audits: state.audits.length, jazzhrCandidates: state.jazzhrCandidates.length };
    },

    async saveJazzhrCandidates(records) {
      state.jazzhrCandidates = normalizeJazzhrCandidates(records);
      const now = new Date().toISOString()
      state.candidateSeenAt = Object.fromEntries(state.jazzhrCandidates.map((item) => [item.candidateKey, now]))
      await persist();
      return state.jazzhrCandidates.length;
    },

    async upsertJazzhrCandidates(records) {
      const merged = new Map(state.jazzhrCandidates.map((candidate) => [candidate.candidateKey, candidate]))
      for (const candidate of normalizeJazzhrCandidates(records)) {
        merged.set(candidate.candidateKey, candidate)
        state.candidateSeenAt[candidate.candidateKey] = new Date().toISOString()
      }
      state.jazzhrCandidates = normalizeJazzhrCandidates([...merged.values()])
      await persist()
      return records.length
    },

    async replaceJazzhrJobCandidates(jobId, records) {
      const normalizedJobId = String(jobId || '').trim()
      const candidates = normalizeJazzhrCandidates(records)
      state.jazzhrCandidates = normalizeJazzhrCandidates([
        ...state.jazzhrCandidates.filter((candidate) => candidate.jazzhrJobId !== normalizedJobId),
        ...candidates,
      ])
      const now = new Date().toISOString()
      const activeKeys = new Set(state.jazzhrCandidates.map((candidate) => candidate.candidateKey))
      state.candidateSeenAt = Object.fromEntries(
        Object.entries(state.candidateSeenAt).filter(([key]) => activeKeys.has(key)),
      )
      for (const candidate of candidates) state.candidateSeenAt[candidate.candidateKey] = now
      await persist()
      return candidates.length
    },

    async searchJazzhrCandidates(query, options = {}) {
      return searchJazzhrCandidateRecords(state.jazzhrCandidates, query, options);
    },

    async listJazzhrCandidates({ limit = 50000 } = {}) {
      return searchJazzhrCandidateRecords(state.jazzhrCandidates, '', { limit });
    },

    async getJazzhrCandidate(jazzhrApplicationId) {
      const id = String(jazzhrApplicationId || '').replace(/^applicant-/, '');
      const candidate = state.jazzhrCandidates.find((item) =>
        item.candidateKey === id || item.jazzhrApplicationId === id
      ) || null;
      if (!candidate) return null;
      return searchJazzhrCandidateRecords([candidate], '', { limit: 1 })[0] || null;
    },

    async getGoogleToken(recruiterId) {
      const stored = state.googleTokens?.[recruiterId];
      if (!stored) return null;
      const payload = typeof stored === 'object' && stored.payload ? stored.payload : stored
      if (typeof stored === 'object' && stored.payload) {
        stored.lastUsedAt = new Date().toISOString()
        await persist()
      }
      return tokenCipher.decrypt(payload);
    },

    async hasGoogleToken(recruiterId) {
      return Boolean(state.googleTokens?.[recruiterId]);
    },

    async listGoogleTokenIds() {
      return Object.keys(state.googleTokens || {})
    },

    async saveGoogleToken(recruiterId, tokenData) {
      const now = new Date().toISOString()
      state.googleTokens[recruiterId] = {
        payload: await tokenCipher.encrypt(tokenData),
        createdAt: state.googleTokens[recruiterId]?.createdAt || now,
        updatedAt: now,
        lastUsedAt: now,
      }
      await persist();
      return tokenData;
    },

    async deleteGoogleToken(recruiterId) {
      delete state.googleTokens[recruiterId];
      await persist();
      return true;
    },

    async createOAuthState(record) {
      state.oauthStates[record.stateHash] = { ...record, consumedAt: null }
      await persist()
      return structuredClone(state.oauthStates[record.stateHash])
    },

    async consumeOAuthState(stateHash, { expectedTeamId = '', now = new Date().toISOString() } = {}) {
      const record = state.oauthStates[stateHash]
      if (!record || record.consumedAt || new Date(record.expiresAt).getTime() <= new Date(now).getTime()) return null
      if (expectedTeamId && record.teamId && record.teamId !== expectedTeamId) return null
      record.consumedAt = now
      await persist()
      return structuredClone(record)
    },

    async consumeRateLimit({ userId, bucket, limit, windowMs, now = new Date().toISOString() }) {
      const nowMs = new Date(now).getTime()
      const windowStartMs = Math.floor(nowMs / windowMs) * windowMs
      const key = `${userId}:${bucket}:${windowStartMs}`
      const current = state.rateLimits[key] || { count: 0, windowStartMs }
      current.count += 1
      state.rateLimits[key] = current
      await persist()
      return {
        allowed: current.count <= limit,
        count: current.count,
        retryAfterMs: Math.max(0, windowStartMs + windowMs - nowMs),
      }
    },

    async purgeRetention({
      now = new Date(),
      completedCaseDays = 365,
      candidateCacheDays = 30,
      googleTokenInactiveDays = 90,
      oauthStateCleanupHours = 24,
      authorizedGoogleUserIds = [],
      dryRun = false,
    } = {}) {
      const nowMs = new Date(now).getTime()
      const caseCutoff = nowMs - completedCaseDays * 86400000
      const candidateCutoff = nowMs - candidateCacheDays * 86400000
      const tokenCutoff = nowMs - googleTokenInactiveDays * 86400000
      const oauthCutoff = nowMs - oauthStateCleanupHours * 3600000
      const removableCases = state.cases.filter((item) =>
        !item.legalHold &&
        (
          ['Completed', 'Cancelled'].includes(item.status) ||
          String(item.rescheduleStatus || '').toLowerCase() === 'cancelled'
        ) &&
        new Date(item.completedAt || item.updatedAt || item.createdAt).getTime() < caseCutoff
      )
      const caseIds = new Set(removableCases.map((item) => item.id))
      const removableCandidates = new Set(
        Object.entries(state.candidateSeenAt)
          .filter(([, seenAt]) => new Date(seenAt).getTime() < candidateCutoff)
          .map(([key]) => key),
      )
      const removableTokens = Object.entries(state.googleTokens)
        .filter(([id, stored]) => {
          if (authorizedGoogleUserIds.length > 0 && !authorizedGoogleUserIds.includes(id)) return true
          if (typeof stored !== 'object') return false
          return new Date(stored.lastUsedAt || stored.updatedAt || stored.createdAt).getTime() < tokenCutoff
        })
        .map(([id]) => id)
      const removableStates = Object.entries(state.oauthStates)
        .filter(([, record]) => new Date(record.expiresAt).getTime() < oauthCutoff)
        .map(([hash]) => hash)
      const result = {
        cases: caseIds.size,
        audits: state.audits.filter((item) => caseIds.has(item.caseId)).length,
        notificationJobs: state.notificationJobs.filter((item) => caseIds.has(item.caseId)).length,
        candidates: removableCandidates.size,
        googleTokens: removableTokens.length,
        oauthStates: removableStates.length,
        dryRun,
      }
      if (dryRun) return result

      state.cases = state.cases.filter((item) => !caseIds.has(item.id))
      state.audits = state.audits.filter((item) => !caseIds.has(item.caseId))
      state.notificationJobs = state.notificationJobs.filter((item) => !caseIds.has(item.caseId))
      state.jazzhrCandidates = state.jazzhrCandidates.filter((item) => !removableCandidates.has(item.candidateKey))
      for (const key of removableCandidates) delete state.candidateSeenAt[key]
      for (const id of removableTokens) delete state.googleTokens[id]
      for (const hash of removableStates) delete state.oauthStates[hash]
      await persist()
      return result
    },

    async close() {
      if (_flushTimer) {
        clearTimeout(_flushTimer)
        _flushTimer = null
      }
      if (_dirty || _flushPromise) {
        await flush()
      }
      await tokenCipher.close?.()
    },

    async createCase(input) {
      const record = {
        id: `case-${crypto.randomUUID()}`,
        status: 'Draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        approvals: [],
        guests: [],
        scheduleVersion: 0,
        rescheduleStatus: 'none',
        scheduleHistory: [],
        interviewWindowStartDate: null,
        interviewWindowEndDate: null,
        interviewTimezone: null,
        selectedInterviewDate: null,
        selectedInterviewTime: null,
        resumeLink: null,
        resumeFile: null,
        attendees: [],
        stageKey: null,
        stageOverrides: {},
        attendanceOverrides: {},
        externalAttendees: [],
        customInvite: null,
        lastAvailabilityCheck: null,
        selectedSlot: null,
        completedAt: null,
        completedBy: null,
        feedbackEmail: null,
        feedbackEmailStatus: null,
        ...input,
      };
      state.cases.unshift(record);
      await persist();
      return record;
    },

    async listCases() {
      return state.cases.map(normalizeCase);
    },

    async listCasesForUser(slackUserId) {
      return state.cases.filter((item) => item.ownerSlackUserId === slackUserId).map(normalizeCase);
    },

    async getCase(id) {
      return normalizeCase(state.cases.find((item) => item.id === id));
    },

    async listNotificationEligibleCases() {
      const stages = new Set(['1st-interview', '2nd-interview', 'final-interview', 'job-offer-discussion'])
      return state.cases
        .filter((item) => item.status === 'Scheduled' && item.currentSchedule && stages.has(item.stageKey))
        .map(normalizeCase)
    },

    async updateCase(id, patch) {
      const index = state.cases.findIndex((item) => item.id === id);
      if (index === -1) throw new Error(`Case not found: ${id}`);
      state.cases[index] = normalizeCase({
        ...state.cases[index],
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await persist();
      return state.cases[index];
    },

    async upsertNotificationJob(input) {
      const index = state.notificationJobs.findIndex((job) =>
        job.caseId === input.caseId &&
        job.type === input.type &&
        Number(job.scheduleVersion || 0) === Number(input.scheduleVersion || 0)
      )
      const now = new Date().toISOString()
      if (index >= 0) {
        const current = state.notificationJobs[index]
        state.notificationJobs[index] = {
          ...current,
          dueAt: input.dueAt,
          payload: input.payload || {},
          ...(current.status === 'completed' ? {} : {
            status: 'pending',
            lockedAt: null,
            lastError: null,
          }),
          updatedAt: now,
        }
      } else {
        state.notificationJobs.push({
          id: input.id || `notification-${crypto.randomUUID()}`,
          caseId: input.caseId,
          type: input.type,
          scheduleVersion: input.scheduleVersion || 0,
          dueAt: input.dueAt,
          status: 'pending',
          attempts: 0,
          maxAttempts: input.maxAttempts || 5,
          payload: input.payload || {},
          lockedAt: null,
          lastError: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        })
      }
      await persist()
      return structuredClone(state.notificationJobs[index >= 0 ? index : state.notificationJobs.length - 1])
    },

    async claimDueNotificationJobs({ now = new Date().toISOString(), limit = 10, leaseMs = 300000 } = {}) {
      const nowMs = new Date(now).getTime()
      const leaseCutoff = nowMs - leaseMs
      const claimed = state.notificationJobs
        .filter((job) => {
          const pending = job.status === 'pending' && new Date(job.dueAt).getTime() <= nowMs
          const expired = job.status === 'running' && new Date(job.lockedAt || 0).getTime() < leaseCutoff
          return (pending || expired) && Number(job.attempts || 0) < Number(job.maxAttempts || 5)
        })
        .sort((left, right) => String(left.dueAt).localeCompare(String(right.dueAt)))
        .slice(0, limit)
      for (const job of claimed) {
        job.status = 'running'
        job.attempts = Number(job.attempts || 0) + 1
        job.lockedAt = now
        job.updatedAt = new Date().toISOString()
      }
      if (claimed.length > 0) await persist()
      return structuredClone(claimed)
    },

    async finishNotificationJob(id, result = {}) {
      const job = state.notificationJobs.find((item) => item.id === id)
      if (!job) return null
      job.status = 'completed'
      job.payload = { ...(job.payload || {}), result }
      job.completedAt = new Date().toISOString()
      job.lockedAt = null
      job.lastError = null
      job.updatedAt = new Date().toISOString()
      await persist()
      return structuredClone(job)
    },

    async retryNotificationJob(id, { dueAt, error } = {}) {
      const job = state.notificationJobs.find((item) => item.id === id)
      if (!job) return null
      job.status = Number(job.attempts || 0) >= Number(job.maxAttempts || 5) ? 'failed' : 'pending'
      job.dueAt = dueAt || job.dueAt
      job.lockedAt = null
      job.lastError = error || null
      job.updatedAt = new Date().toISOString()
      await persist()
      return structuredClone(job)
    },

    async cancelNotificationJobs(caseId, { exceptScheduleVersion } = {}) {
      let count = 0
      for (const job of state.notificationJobs) {
        if (job.caseId !== caseId) continue
        if (exceptScheduleVersion !== undefined && Number(job.scheduleVersion) === Number(exceptScheduleVersion)) continue
        if (!['pending', 'running', 'failed'].includes(job.status)) continue
        job.status = 'cancelled'
        job.lockedAt = null
        job.updatedAt = new Date().toISOString()
        count += 1
      }
      if (count > 0) await persist()
      return count
    },

    async completeCase(caseId, {
      actorSlackUserId,
      expectedScheduleVersion,
      completedAt,
      feedbackJob,
    }) {
      const index = state.cases.findIndex((item) => item.id === caseId)
      if (index === -1) throw new Error(`Case not found: ${caseId}`)
      const current = state.cases[index]
      if (current.status === 'Completed') {
        return { caseRecord: normalizeCase(current), alreadyCompleted: true }
      }
      if (
        expectedScheduleVersion !== undefined &&
        Number(expectedScheduleVersion) !== Number(current.scheduleVersion || 1)
      ) {
        return { caseRecord: normalizeCase(current), alreadyCompleted: false, stale: true }
      }
      state.cases[index] = normalizeCase({
        ...current,
        status: 'Completed',
        completedAt,
        completedBy: actorSlackUserId || null,
        actionLock: null,
        lastActionAt: completedAt,
        lastActionBy: actorSlackUserId || null,
        updatedAt: new Date().toISOString(),
      })
      for (const job of state.notificationJobs) {
        if (job.caseId === caseId && job.type !== 'feedback-request' && ['pending', 'running', 'failed'].includes(job.status)) {
          job.status = 'cancelled'
          job.lockedAt = null
        }
      }
      if (feedbackJob) {
        const exists = state.notificationJobs.some((job) =>
          job.caseId === caseId &&
          job.type === feedbackJob.type &&
          Number(job.scheduleVersion) === Number(current.scheduleVersion || 1)
        )
        if (!exists) {
          state.notificationJobs.push({
            id: feedbackJob.id || `notification-${crypto.randomUUID()}`,
            caseId,
            type: feedbackJob.type,
            scheduleVersion: current.scheduleVersion || 1,
            dueAt: feedbackJob.dueAt,
            status: 'pending',
            attempts: 0,
            maxAttempts: 5,
            payload: feedbackJob.payload || {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
        }
      }
      await persist()
      return { caseRecord: state.cases[index], alreadyCompleted: false }
    },

    async addAudit(entry) {
      const audit = {
        id: `audit-${crypto.randomUUID()}`,
        at: new Date().toISOString(),
        ...entry,
      };
      state.audits.unshift(audit);
      await persist();
      return audit;
    },

    async listAudits(caseId, { limit = 5 } = {}) {
      return state.audits
        .filter((a) => a.caseId === caseId)
        .slice(0, limit);
    },
  };
}

async function writeFileAtomically(targetPath, payload) {
  const directory = path.dirname(targetPath)
  await fs.mkdir(directory, { recursive: true })
  const tempPath = path.join(
    directory,
    `${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
  )
  try {
    await fs.writeFile(tempPath, payload)
    await fs.rename(tempPath, targetPath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function normalizeLoadedState(parsed) {
  const loaded = { ...structuredClone(DEFAULT_STATE), ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  loaded.cases = normalizeArray(loaded.cases).map(normalizeCase)
  loaded.audits = normalizeArray(loaded.audits)
  loaded.jazzhrCandidates = normalizeJazzhrCandidates(loaded.jazzhrCandidates)
  loaded.notificationJobs = normalizeArray(loaded.notificationJobs)
  loaded.googleTokens = loaded.googleTokens && typeof loaded.googleTokens === 'object' ? loaded.googleTokens : {}
  loaded.oauthStates = loaded.oauthStates && typeof loaded.oauthStates === 'object' ? loaded.oauthStates : {}
  loaded.rateLimits = loaded.rateLimits && typeof loaded.rateLimits === 'object' ? loaded.rateLimits : {}
  loaded.candidateSeenAt = loaded.candidateSeenAt && typeof loaded.candidateSeenAt === 'object' ? loaded.candidateSeenAt : {}
  return loaded
}

function normalizeCipher(cipher) {
  if (cipher && typeof cipher.encrypt === 'function' && typeof cipher.decrypt === 'function') return cipher
  const encryptionKey = String(cipher || '')
  return {
    async encrypt(value) {
      return encryptionKey ? await encryptJson(value, encryptionKey) : JSON.stringify(value)
    },
    async decrypt(payload) {
      if (typeof payload !== 'string') return payload
      if (encryptionKey && payload.includes('.')) {
        try {
          return await decryptJson(payload, encryptionKey)
        } catch {
          return null
        }
      }
      try {
        return JSON.parse(payload)
      } catch {
        return null
      }
    },
    async close() {},
  }
}
