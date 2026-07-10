import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createPostgresStore } from '../../src/store/postgres-store.js'
import { createTokenCipher } from '../../src/security/token-cipher.js'

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations'
)

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
export const HAS_TEST_DB = Boolean(TEST_DATABASE_URL)

let _migrationsApplied = false

async function ensureMigrationsTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
  )
}

async function loadMigrationFiles() {
  const entries = await fs.readdir(migrationsDir)
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

export async function ensureTestMigrations(pool) {
  if (_migrationsApplied) return

  const client = await pool.connect()
  try {
    await ensureMigrationsTable(client)

    const appliedResult = await client.query('SELECT filename FROM schema_migrations')
    const applied = new Set(appliedResult.rows.map((row) => row.filename))

    const migrations = await loadMigrationFiles()

    for (const filename of migrations) {
      if (applied.has(filename)) continue

      const filePath = path.join(migrationsDir, filename)
      const sql = await fs.readFile(filePath, 'utf8')

      if (!sql.trim()) continue

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }

    _migrationsApplied = true
  } finally {
    client.release()
  }
}

export async function truncateTestTables(pool) {
  await pool.query(
    `TRUNCATE
      scheduling_cases,
      audit_events,
      encrypted_google_tokens,
      oauth_states,
      rate_limit_counters,
      jazzhr_candidates,
      notification_jobs,
      talent_directory
    CASCADE`
  )
}

export function createTestConfig(databaseUrl) {
  return {
    databaseUrl: databaseUrl || TEST_DATABASE_URL,
    database: {
      sslMode: 'disable',
      maxConnections: 2,
    },
  }
}

export function createTestTokenCipher() {
  return createTokenCipher({ security: {} })
}

export function createTestPostgresStore(databaseUrl) {
  return createPostgresStore(createTestConfig(databaseUrl), createTestTokenCipher())
}

export async function createTestPool(databaseUrl) {
  const url = databaseUrl || TEST_DATABASE_URL
  return new pg.Pool({ connectionString: url, max: 2 })
}
