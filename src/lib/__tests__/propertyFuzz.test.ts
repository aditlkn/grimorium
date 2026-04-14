import { describe, expect, it } from 'vitest'
import { runFuzzSimulation, summarizeFuzzCoverage } from '../testing/fuzz'

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function seedsForRun(runCount: number, fixedSeed?: number): number[] {
  if (fixedSeed !== undefined) return [fixedSeed]
  return Array.from({ length: runCount }, (_, index) => index + 1)
}

function replayCommand(seed: number, maxSteps: number): string {
  return `FUZZ_SEED=${seed} FUZZ_MAX_STEPS=${maxSteps} npm run test:fuzz:smoke`
}

describe('property fuzz: engine invariants', () => {
  it('holds across seeded randomized simulations', () => {
    const env =
      (
        globalThis as {
          process?: { env?: Record<string, string | undefined> }
        }
      ).process?.env ?? {}

    const runs = parsePositiveInt(env.FUZZ_RUNS, 25)
    const maxSteps = parsePositiveInt(env.FUZZ_MAX_STEPS, 120)
    const replaySeed = env.FUZZ_SEED
      ? parsePositiveInt(env.FUZZ_SEED, 1)
      : undefined
    const seeds = seedsForRun(runs, replaySeed)
    const enforceCoverage = env.FUZZ_ENFORCE_ROLE_COVERAGE === '1'

    const results = seeds.map((seed) => {
      try {
        return runFuzzSimulation({
          seed,
          maxSteps,
        })
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error)
        throw new Error(
          [
            `Fuzz run failed for seed=${seed}.`,
            `Replay: ${replayCommand(seed, maxSteps)}`,
            details,
          ].join('\n'),
        )
      }
    })

    expect(results.length).toBe(seeds.length)
    for (const result of results) {
      expect(result.stepsExecuted).toBeGreaterThan(0)
    }

    const coverage = summarizeFuzzCoverage(results)
    const sortedUncovered = [...coverage.uncoveredRoles].sort()
    const sortedCoverageEntries = Object.entries(coverage.roleCoverage).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )
    console.info(
      `FUZZ coverage summary (runs=${results.length}, maxSteps=${maxSteps}): ${sortedCoverageEntries
        .map(([roleId, hits]) => `${roleId}:${hits}`)
        .join(', ')}`,
    )
    if (sortedUncovered.length > 0) {
      console.info(`FUZZ uncovered roles: ${sortedUncovered.join(', ')}`)
    } else {
      console.info('FUZZ uncovered roles: none')
    }

    if (enforceCoverage) {
      expect(
        sortedUncovered,
        `Fuzz coverage missing roles. Re-run with higher FUZZ_RUNS/FUZZ_MAX_STEPS. Replay seed example: ${replayCommand(1, maxSteps)}`,
      ).toEqual([])
    }
  })
})
