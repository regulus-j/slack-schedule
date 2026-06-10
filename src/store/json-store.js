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
        attendees: [],
        stageKey: null,
        stageOverrides: {},
        attendanceOverrides: {},
        externalAttendees: [],
        customInvite: null,
        lastAvailabilityCheck: null,
        selectedSlot: null,
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
