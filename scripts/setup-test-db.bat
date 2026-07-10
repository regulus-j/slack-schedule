@echo off
REM Setup script for Postgres-backed tests
REM Run this from the project root

echo === Step 1: Create test database (if not exists) ===
node -e "import('pg').then(pg => { const p = new pg.default.Pool({ connectionString: 'postgres://postgres:xxxxxxx@localhost:5432/postgres?sslmode=disable', max: 1 }); p.query('SELECT 1 FROM pg_database WHERE datname = \$1', ['opg_test']).then(r => { if (r.rows.length === 0) { console.log('Creating opg_test database...'); return p.query('CREATE DATABASE opg_test WITH TEMPLATE template0 ENCODING \$\$UTF8\$\$'); } else { console.log('opg_test already exists'); } }).then(() => { console.log('Done'); p.end(); }).catch(e => { console.error('Error:', e.message); p.end(); process.exit(1); }); });"

echo.
echo === Step 2: Run Postgres store tests ===
set TEST_DATABASE_URL=postgres://postgres:xxxxxxx@localhost:5432/opg_test?sslmode=disable
node --test tests/postgres-store.test.js

echo.
echo === Step 3: Run ALL tests (JSON + Postgres) ===
node --test
