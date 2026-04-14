import { describe, expect, it } from 'vitest'
import { runFuzzSimulation } from '../testing/fuzz'

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

    const results = seeds.map((seed) =>
      runFuzzSimulation({
        seed,
        maxSteps,
      }),
    )

    expect(results.length).toBe(seeds.length)
    for (const result of results) {
      expect(result.stepsExecuted).toBeGreaterThan(0)
    }
  })
})
