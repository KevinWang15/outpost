// Host launcher (`npm run onboarding:capture`) that builds and runs the Linux GUI
// Docker container to regenerate all Web UI and Outpost Desktop onboarding screenshots.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const outDir = resolve(repoRoot, 'docs/onboarding')
mkdirSync(outDir, { recursive: true })

const args = new Set(process.argv.slice(2))
const mode = args.has('--web-only') ? 'web' : args.has('--desktop-only') ? 'desktop' : 'all'
const noCache = args.has('--no-cache')
const imageTag = process.env.OUTPOST_ONBOARDING_IMAGE ?? 'outpost-onboarding-capture:latest'

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log(`Building GUI screenshot container (${imageTag})...`)
run('docker', [
  'build',
  ...(noCache ? ['--no-cache'] : []),
  '-f',
  'scripts/onboarding-capture/Dockerfile',
  '-t',
  imageTag,
  'scripts/onboarding-capture',
])

console.log(`Capturing onboarding screenshots (mode=${mode}) -> docs/onboarding/...`)
run('docker', [
  'run',
  '--rm',
  '-v',
  `${repoRoot}:/repo:ro`,
  '-v',
  `${outDir}:/output`,
  '-v',
  'outpost-onboarding-cargo:/cache/cargo',
  '-v',
  'outpost-onboarding-target:/cache/target',
  '-v',
  'outpost-onboarding-node:/work/node_modules',
  '-v',
  'outpost-onboarding-machine:/cache/machine_test_dist',
  imageTag,
  'bash',
  '-c',
  'tr -d "\\r" < /repo/scripts/onboarding-capture/run-in-container.sh | bash -s -- "$1"',
  '--',
  mode,
])
