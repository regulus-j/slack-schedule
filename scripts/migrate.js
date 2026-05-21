import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Client } = pg

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is required to run migrations.')
  process.exit(1)
}

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations'
)

async function ensureMigrationsTable(client) {
  await client.query(
    `create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`
  )
}

async function loadAppliedMigrations(client) {
  const result = await client.query('select filename from schema_migrations')
  return new Set(result.rows.map((row) => row.filename))
}

async function loadMigrationFiles() {
  const entries = await fs.readdir(migrationsDir)
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

async function applyMigration(client, filename) {
  const filePath = path.join(migrationsDir, filename)
  const sql = await fs.readFile(filePath, 'utf8')

  if (!sql.trim()) {
    console.warn(`Skipping empty migration: ${filename}`)
    return
  }

  await client.query('begin')
  try {
    await client.query(sql)
    await client.query('insert into schema_migrations (filename) values ($1)', [filename])
    await client.query('commit')
    console.log(`Applied ${filename}`)
  } catch (error) {
    await client.query('rollback')
    throw error
  }
}

async function run() {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    await ensureMigrationsTable(client)

    const applied = await loadAppliedMigrations(client)
    const migrations = await loadMigrationFiles()

    if (migrations.length === 0) {
      console.log('No migrations found.')
      return
    }

    for (const migration of migrations) {
      if (applied.has(migration)) {
        continue
      }

      await applyMigration(client, migration)
    }

    console.log('Migrations complete.')
  } finally {
    await client.end()
  }
}

run().catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
