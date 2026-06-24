export async function createPostgresPool(config) {
  const { Pool } = await import('pg')
  if (config?.database?.backend === 'cloudsql') {
    const { Connector, IpAddressTypes } = await import('@google-cloud/cloud-sql-connector')
    const connector = new Connector()
    const ipType = String(config.database.ipType || 'PRIVATE').toUpperCase() === 'PUBLIC'
      ? IpAddressTypes.PUBLIC
      : IpAddressTypes.PRIVATE
    const connectorOptions = await connector.getOptions({
      instanceConnectionName: config.database.instanceConnectionName,
      ipType,
      authType: 'IAM',
    })
    const pool = new Pool({
      ...connectorOptions,
      user: config.database.user,
      database: config.database.name,
      max: config.database.maxConnections || 5,
    })
    return {
      pool,
      async close() {
        await pool.end()
        connector.close()
      },
    }
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: true },
    max: config?.database?.maxConnections || 5,
  })
  return {
    pool,
    async close() {
      await pool.end()
    },
  }
}
