#!/usr/bin/env node
/**
 * One-shot provisioning for a fresh Cloudflare account (DEVELOPMENT.md → Phase 0).
 *
 * Creates the R2 bucket and D1 database, writes the D1 id into wrangler.jsonc,
 * and applies migrations. Idempotent: re-running skips resources that exist.
 *
 *   pnpm setup            # provision + apply migrations to the remote D1
 *   pnpm setup --local    # also create/apply the local dev D1
 *
 * Requires: `wrangler login` (or CLOUDFLARE_API_TOKEN) beforehand.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const wranglerConfigPath = resolve(repoRoot, 'wrangler.jsonc')

const R2_BUCKET = 'cf-mediashare-media'
const D1_NAME = 'cf-mediashare-db'
const ID_PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID'

const withLocal = process.argv.includes('--local')

/** Run wrangler, capturing stdout. Returns { ok, stdout, stderr }. */
function wrangler(args, { capture = true } = {}) {
  const res = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

function log(msg) {
  process.stdout.write(`\n› ${msg}\n`)
}

function die(msg, detail) {
  process.stderr.write(`\n✗ ${msg}\n${detail ? detail + '\n' : ''}`)
  process.exit(1)
}

// --- R2 bucket -------------------------------------------------------------
function ensureBucket() {
  log(`Ensuring R2 bucket "${R2_BUCKET}"`)
  const list = wrangler(['r2', 'bucket', 'list'])
  if (list.ok && list.stdout.includes(R2_BUCKET)) {
    process.stdout.write('  already exists — skipping\n')
    return
  }
  const create = wrangler(['r2', 'bucket', 'create', R2_BUCKET])
  if (!create.ok && !/already (exists|owned)/i.test(create.stderr)) {
    die(`Failed to create R2 bucket "${R2_BUCKET}"`, create.stderr)
  }
  process.stdout.write('  created\n')
}

// --- D1 database -----------------------------------------------------------
function findExistingD1Id() {
  const res = wrangler(['d1', 'list', '--json'])
  if (!res.ok) return null
  try {
    const dbs = JSON.parse(res.stdout)
    const match = dbs.find((d) => d.name === D1_NAME)
    return match ? (match.uuid ?? match.database_id ?? null) : null
  } catch {
    return null
  }
}

function ensureD1() {
  log(`Ensuring D1 database "${D1_NAME}"`)
  const existing = findExistingD1Id()
  if (existing) {
    process.stdout.write(`  already exists (${existing}) — skipping\n`)
    return existing
  }
  const create = wrangler(['d1', 'create', D1_NAME])
  if (!create.ok) die(`Failed to create D1 database "${D1_NAME}"`, create.stderr)
  const id = (create.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ||
    [])[0]
  if (!id) die('Created D1 but could not parse its database_id from output', create.stdout)
  process.stdout.write(`  created (${id})\n`)
  return id
}

// --- Patch wrangler.jsonc --------------------------------------------------
function writeD1Id(id) {
  const raw = readFileSync(wranglerConfigPath, 'utf8')
  if (raw.includes(`"${id}"`)) {
    process.stdout.write('  wrangler.jsonc already has the database_id\n')
    return
  }
  if (!raw.includes(ID_PLACEHOLDER)) {
    process.stdout.write(
      `  wrangler.jsonc has a different database_id already — leaving it. ` +
        `Set it to ${id} manually if that is wrong.\n`,
    )
    return
  }
  writeFileSync(wranglerConfigPath, raw.replace(ID_PLACEHOLDER, id))
  process.stdout.write(`  wrote database_id into wrangler.jsonc\n`)
}

// --- Migrations ------------------------------------------------------------
function applyMigrations() {
  log('Applying D1 migrations (remote)')
  const remote = wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote'], { capture: false })
  if (!remote.ok) die('Remote migrations failed')

  if (withLocal) {
    log('Applying D1 migrations (local)')
    const local = wrangler(['d1', 'migrations', 'apply', D1_NAME, '--local'], { capture: false })
    if (!local.ok) die('Local migrations failed')
  }
}

// --- Run -------------------------------------------------------------------
log('cf-mediashare provisioning')
ensureBucket()
const d1Id = ensureD1()
writeD1Id(d1Id)
applyMigrations()

log('Done.')
process.stdout.write(
  [
    'Next steps:',
    '  1. Configure Cloudflare Access in the Zero Trust dashboard (see DEPLOY.md).',
    '  2. Seed groups + members: copy scripts/setup/seed.example.sql → seed.sql, edit, then',
    '     wrangler d1 execute cf-mediashare-db --remote --file scripts/setup/seed.sql',
    '  3. pnpm deploy',
    '',
  ].join('\n'),
)
