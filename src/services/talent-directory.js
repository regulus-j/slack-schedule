import { readFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { setHiringManagers, setTalentRecruiters } from '../data/cache.js';
import { fetchRecruiterPhoneRows, mergeRecruiterPhones, recruiterRowsToPeople } from './recruiter-phone-export.js';

export async function loadTalentDirectory(config, store) {
  let people
  let source

  if (typeof store?.listTalentDirectory === 'function') {
    try {
      people = await store.listTalentDirectory()
      source = 'postgres:talent_directory'
    } catch (err) {
      logger.warn('talent_directory_postgres_failed', { error: err.message })
    }
  }

  if (!people) {
    const filePath = path.join(config.runtimeDir, 'talent_directory.sql');
    let sql;
    try {
      sql = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read talent directory file at ${filePath}: ${err.message}`);
    }
    people = parseTalentDirectory(sql)
    source = filePath
  }

  const phoneRows = await fetchRecruiterPhoneRows({ config, logger })

  setHiringManagers(people);
  const baseRecruiters = people.filter(isRecruitmentTalent).map((person) => ({
    ...person,
    id: person.id.replace(/^hm-/, 'talent-rec-'),
    role: 'recruiter',
  }))
  const sheetRecruiters = recruiterRowsToPeople(phoneRows)
  const enrichedBaseRecruiters = mergeRecruiterPhones(baseRecruiters, phoneRows)
  const talentRecruiters = mergeRecruiterLists(sheetRecruiters, enrichedBaseRecruiters)
  setTalentRecruiters(talentRecruiters)

  logger.info('talent_directory_loaded', {
    count: people.length,
    recruiters: talentRecruiters.length,
    sheetRecruiters: sheetRecruiters.length,
    source,
  });
  return people;
}

export function parseTalentDirectory(sql) {
  const people = [];
  let counter = 1;

  const insertPattern = /INSERT\s+INTO\s+talent_directory\s*\([^)]+\)\s*VALUES\s*([\s\S]*?);/gi;

  for (const match of sql.matchAll(insertPattern)) {
    const valuesBlock = match[1];
    const tuples = extractTuples(valuesBlock);

    for (const tuple of tuples) {
      const fields = parseSqlTuple(tuple);
      if (!fields || fields.length < 5) {
        logger.warn('talent_directory_skip_tuple', { tuple: tuple.slice(0, 80) });
        continue;
      }

      const [firstName, lastName, designation, department, workEmail] = fields;
      const person = normalizeTalentPerson({ firstName, lastName, designation, department, workEmail }, counter)

      if (!person) {
        const name = [firstName, lastName].filter(Boolean).join(' ').trim()
        logger.warn('talent_directory_skip_row', { name, email: workEmail });
        continue;
      }

      people.push(person);

      counter++;
    }
  }

  return people;
}

export function normalizeTalentPerson(row, counter = 1) {
  const firstName = row.first_name ?? row.firstName ?? row.first ?? ''
  const lastName = row.last_name ?? row.lastName ?? row.last ?? ''
  const designation = row.designation ?? row.position_title ?? row.positionTitle ?? row.title ?? ''
  const department = row.department ?? ''
  const workEmail = row.work_email ?? row.workEmail ?? row.email ?? ''
  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || row.name || ''

  if (!name || !workEmail) return null

  return {
    id: `hm-${counter}`,
    name,
    email: workEmail,
    role: 'hiring_manager',
    slackUserId: '',
    positionTitle: designation,
    department,
  }
}

export function isRecruitmentTalent(person) {
  const haystack = [
    person?.role,
    person?.positionTitle,
    person?.designation,
    person?.department,
  ].join(' ').toLowerCase()
  return haystack.includes('recruitment')
}

function mergeRecruiterLists(primaryRecruiters, fallbackRecruiters) {
  const merged = []
  const seen = new Set()

  for (const recruiter of [...primaryRecruiters, ...fallbackRecruiters]) {
    const key = recruiterKey(recruiter)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(recruiter)
  }

  return merged
}

function recruiterKey(recruiter) {
  return String(recruiter?.email || recruiter?.name || '').trim().toLowerCase()
}

function extractTuples(valuesBlock) {
  const tuples = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < valuesBlock.length; i++) {
    const ch = valuesBlock[i];

    if (ch === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && start >= 0) {
        tuples.push(valuesBlock.slice(start + 1, i));
        start = -1;
      }
    }
  }

  return tuples;
}

function parseSqlTuple(tuple) {
  const fields = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i];

    if (inString) {
      if (ch === "'") {
        if (i + 1 < tuple.length && tuple[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inString = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === "'") {
        inString = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }

  fields.push(current.trim());

  return fields.map((field) => {
    const upper = field.toUpperCase();
    if (upper === 'NULL') return '';
    return field;
  });
}
