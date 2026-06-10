#!/usr/bin/env node
/**
 * One-shot provisioning for a fresh Cloudflare account.
 *
 * Creates the R2 bucket and D1 database, writes the D1 id + account id into
 * wrangler.jsonc, applies migrations, and sets the bucket CORS rules needed for
 * direct-to-R2 browser uploads. Idempotent: re-running skips what exists.
 *
 *   pnpm setup                          # provision + migrate (remote)
 *   pnpm setup --local                  # also migrate the local dev D1
 *   pnpm setup --origin https://x.dev   # restrict upload CORS to your app origin
 *
 * Requires: `wrangler login` (or CLOUDFLARE_API_TOKEN) beforehand.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const wranglerConfigPath = resolve(repoRoot, 'wrangler.jsonc')

const R2_BUCKET = 'cf-mediashare-media'
const D1_NAME = 'cf-mediashare-db'
const ID_PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID'

const withLocal = process.argv.includes('--local')
const originFlag = process.argv.indexOf('--origin')
const corsOrigin = originFlag !== -1 ? process.argv[originFlag + 1] : '*'

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

// --- R2 CORS ----------------------------------------------------------------
// Direct-to-R2 uploads are presigned PUTs from the browser, so the bucket must
// answer CORS preflights. This is not a data-exposure surface: the bucket stays
// private and only signed URLs grant access — CORS merely lets the browser send
// the PUT. Pass --origin to pin it to your app origin instead of "*".
function setBucketCors() {
  log(`Setting CORS rules on "${R2_BUCKET}" (origin: ${corsOrigin})`)
  const rules = [
    {
      AllowedOrigins: [corsOrigin],
      AllowedMethods: ['GET', 'PUT'],
      AllowedHeaders: ['content-type'],
      MaxAgeSeconds: 3600,
    },
  ]
  const tmp = mkdtempSync(join(tmpdir(), 'cf-mediashare-'))
  const file = join(tmp, 'cors.json')
  writeFileSync(file, JSON.stringify(rules, null, 2))
  try {
    const res = wrangler(['r2', 'bucket', 'cors', 'set', R2_BUCKET, '--file', file, '--force'])
    if (!res.ok) {
      // Non-fatal: uploads still work via the Worker proxy fallback without CORS.
      process.stdout.write(
        `  ⚠ could not set CORS (${res.stderr.trim().split('\n')[0]}) — set it later:\n` +
          `    pnpm exec wrangler r2 bucket cors set ${R2_BUCKET} --file <rules.json>\n`,
      )
      return
    }
    process.stdout.write('  done\n')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
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

// --- Account id -------------------------------------------------------------
function findAccountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID
  const res = wrangler(['whoami'])
  if (!res.ok) return null
  const id = (res.stdout.match(/\b[0-9a-f]{32}\b/) || [])[0]
  return id ?? null
}

// --- Patch wrangler.jsonc --------------------------------------------------
/** Replace `placeholder` with `replacement` in wrangler.jsonc, idempotently. */
function writeConfigValue(label, placeholder, replacement) {
  const raw = readFileSync(wranglerConfigPath, 'utf8')
  if (raw.includes(replacement)) {
    process.stdout.write(`  wrangler.jsonc already has the ${label}\n`)
    return
  }
  if (!raw.includes(placeholder)) {
    process.stdout.write(
      `  wrangler.jsonc has a different ${label} already — leaving it. ` +
        `Expected to write: ${replacement}\n`,
    )
    return
  }
  writeFileSync(wranglerConfigPath, raw.replace(placeholder, replacement))
  process.stdout.write(`  wrote ${label} into wrangler.jsonc\n`)
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
setBucketCors()
const d1Id = ensureD1()
writeConfigValue('database_id', ID_PLACEHOLDER, d1Id)
const accountId = findAccountId()
if (accountId) {
  log('Writing account id (CF_ACCOUNT_ID) into wrangler.jsonc')
  writeConfigValue('CF_ACCOUNT_ID', '"CF_ACCOUNT_ID": ""', `"CF_ACCOUNT_ID": "${accountId}"`)
} else {
  log('⚠ Could not determine your account id — set vars.CF_ACCOUNT_ID in wrangler.jsonc manually')
}
applyMigrations()

log('Done.')
process.stdout.write(
  [
    'Next steps:',
    '  1. Configure Cloudflare Access in the Zero Trust dashboard (see DEPLOY.md) and set',
    '     ACCESS_TEAM_DOMAIN + ACCESS_AUD in wrangler.jsonc.',
    '  2. Create an R2 API token (Object Read & Write, scoped to this bucket) so uploads go',
    '     directly to R2 instead of through the Worker:',
    '       pnpm exec wrangler secret put R2_ACCESS_KEY_ID',
    '       pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY',
    '     (Optional — without them, uploads proxy through the Worker.)',
    '  3. Seed groups + members: copy scripts/setup/seed.example.sql → seed.sql, edit, then',
    '     wrangler d1 execute cf-mediashare-db --remote --file scripts/setup/seed.sql',
    '  4. pnpm deploy',
    '',
  ].join('\n'),
)
