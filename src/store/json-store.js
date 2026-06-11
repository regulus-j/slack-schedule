import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decryptJson, encryptJson } from '../security/crypto.js';
import { normalizeJazzhrCandidates, searchJazzhrCandidateRecords } from './candidate-index.js';

const DEFAULT_STATE = {
  cases: [],
  audits: [],
  googleTokens: {},
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

export function createJsonStore(runtimeDir, encryptionKey = '') {
  const statePath = path.join(runtimeDir, 'state.json');
  let state = structuredClone(DEFAULT_STATE);

  async function persist() {
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  return {
    async init() {
      await fs.mkdir(runtimeDir, { recursive: true });
      try {
        const raw = await fs.readFile(statePath, 'utf8');
        state = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(raw) };
        state.cases = normalizeArray(state.cases).map(normalizeCase)
        state.jazzhrCandidates = normalizeJazzhrCandidates(state.jazzhrCandidates)
        state.notificationJobs = normalizeArray(state.notificationJobs)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await persist();
      }
    },

    async stats() {
      return { cases: state.cases.length, audits: state.audits.length, jazzhrCandidates: state.jazzhrCandidates.length };
    },

    async saveJazzhrCandidates(records) {
      state.jazzhrCandidates = normalizeJazzhrCandidates(records);
      await persist();
      return state.jazzhrCandidates.length;
    },

    async upsertJazzhrCandidates(records) {
      const merged = new Map(state.jazzhrCandidates.map((candidate) => [candidate.candidateKey, candidate]))
      for (const candidate of normalizeJazzhrCandidates(records)) {
        merged.set(candidate.candidateKey, candidate)
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
      const payload = state.googleTokens?.[recruiterId];
      if (!payload) return null;
      return decodeTokenPayload(payload, encryptionKey);
    },

    async hasGoogleToken(recruiterId) {
      return Boolean(state.googleTokens?.[recruiterId]);
    },

    async saveGoogleToken(recruiterId, tokenData) {
      state.googleTokens[recruiterId] = encodeTokenPayload(tokenData, encryptionKey);
      await persist();
      return tokenData;
    },

    async deleteGoogleToken(recruiterId) {
      delete state.googleTokens[recruiterId];
      await persist();
      return true;
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

function encodeTokenPayload(tokenData, encryptionKey) {
  if (encryptionKey) return encryptJson(tokenData, encryptionKey);
  return JSON.stringify(tokenData);
}

function decodeTokenPayload(payload, encryptionKey) {
  if (typeof payload !== 'string') return payload;
  if (encryptionKey && payload.includes('.')) {
    try {
      return decryptJson(payload, encryptionKey);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
