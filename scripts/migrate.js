import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { createPostgresPool } from '../src/store/postgres-connection.js'

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

async function grantRuntimePrivileges(client, databaseName, runtimeUser) {
  const user = String(runtimeUser || '').trim()
  if (!user) return
  const userIdentifier = quoteIdentifier(user)
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${userIdentifier}`)
  await client.query(`GRANT USAGE ON SCHEMA public TO ${userIdentifier}`)
  await client.query(`REVOKE CREATE ON SCHEMA public FROM ${userIdentifier}`)
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${userIdentifier}`)
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${userIdentifier}`)
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${userIdentifier}`)
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${userIdentifier}`)
}

function quoteIdentifier(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`
}

async function run() {
  const config = loadConfig()
  if (config.database.backend === 'json') {
    throw new Error('PostgreSQL configuration is required to run migrations.')
  }
  const connection = await createPostgresPool(config)
  const client = await connection.pool.connect()

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

    const runtimeUser = process.env.RUNTIME_CLOUD_SQL_IAM_USER || config.database.user
    await grantRuntimePrivileges(client, config.database.name, runtimeUser)
    console.log('Migrations complete.')
  } finally {
    client.release()
    await connection.close()
  }
}

run().catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
