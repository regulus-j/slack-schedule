import { readFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { setHiringManagers } from '../data/cache.js';

export function loadTalentDirectory(config) {
  const filePath = path.join(config.runtimeDir, 'talent_directory.sql');

  let sql;
  try {
    sql = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read talent directory file at ${filePath}: ${err.message}`);
  }

  const people = parseTalentDirectory(sql);
  setHiringManagers(people);

  logger.info('talent_directory_loaded', { count: people.length, source: filePath });
  return people;
}

function parseTalentDirectory(sql) {
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
      const name = [firstName, lastName].filter(Boolean).join(' ').trim();

      if (!name || !workEmail) {
        logger.warn('talent_directory_skip_row', { name, email: workEmail });
        continue;
      }

      people.push({
        id: `hm-${counter}`,
        name,
        email: workEmail,
        role: 'hiring_manager',
        slackUserId: '',
        positionTitle: designation,
        department,
      });

      counter++;
    }
  }

  return people;
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
