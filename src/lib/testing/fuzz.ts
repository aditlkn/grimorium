import {
  executeAtEndOfDay,
  getNextStep,
  getVoteThreshold,
  markRoleRevealed,
  nominate,
  resolveVote,
  skipNightAction,
  startDay,
  startNight,
} from '../game'
import { applyPipelineChanges, resolveIntent } from '../pipeline'
import { getCurrentTeam } from '../identity'
import { getAlivePlayers, type Game } from '../types'
import type { RoleId } from '../roles/types'
import { ROLE_TEST_CONTRACTS } from './roleContracts'
import { assertEngineInvariants } from './invariants'
import { deriveWakeOrderFromRoleIds } from '../scripts/wakeOrder'
import { createGame } from '../game'

export type FuzzConfig = {
  seed: number
  maxSteps: number
  playerCount?: number
}

export type FuzzResult = {
  seed: number
  stepsExecuted: number
  trace: string[]
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}

function pickOne<T>(rng: () => number, values: T[]): T {
  return values[randomInt(rng, 0, values.length - 1)]
}

function sampleRoles(rng: () => number, playerCount: number): RoleId[] {
  const all = Object.keys(ROLE_TEST_CONTRACTS) as RoleId[]
  const picked = new Set<RoleId>(['imp', 'villager'])
  while (picked.size < playerCount) {
    picked.add(pickOne(rng, all))
  }
  return Array.from(picked)
}

function createFuzzGame(seed: number, playerCount?: number): Game {
  const rng = mulberry32(seed)
  const count = playerCount ?? randomInt(rng, 5, 10)
  const roles = sampleRoles(rng, count)
  const players = roles.map((roleId, index) => ({
    name: `F${index + 1}`,
    roleId,
  }))

  const scriptId = `fuzz-${seed}`
  const scriptSnapshot = {
    id: scriptId,
    source: 'custom' as const,
    name: `Fuzz ${seed}`,
    icon: 'settings' as const,
    roles,
    enforceDistribution: false,
    wakeOrder: deriveWakeOrderFromRoleIds(roles),
    isOfficial: false,
  }

  return createGame(`Fuzz ${seed}`, scriptId, players, scriptSnapshot)
}

function tryResolveRandomKill(
  game: Game,
  rng: () => number,
  sourcePlayerId: string,
): Game {
  const state = game.history.at(-1)?.stateAfter
  if (!state) return game

  const alive = getAlivePlayers(state)
  if (alive.length === 0) return game

  const target = pickOne(rng, alive)
  const result = resolveIntent(
    {
      type: 'kill',
      sourceId: sourcePlayerId,
      targetId: target.id,
      cause: 'fuzz_night_kill',
    },
    state,
    game,
  )

  if (result.type === 'needs_input') return game
  return applyPipelineChanges(game, result.stateChanges)
}

function tryRandomNomination(game: Game, rng: () => number): Game {
  const state = game.history.at(-1)?.stateAfter
  if (!state) return game
  const alive = getAlivePlayers(state)
  if (alive.length < 2) return game

  const nominator = pickOne(rng, alive)
  const nomineePool = alive.filter((player) => player.id !== nominator.id)
  if (nomineePool.length === 0) return game
  const nominee = pickOne(rng, nomineePool)

  let next = nominate(game, nominator.id, nominee.id)
  const threshold = getVoteThreshold(next.history.at(-1)!.stateAfter)
  const voteCount = randomInt(rng, 0, Math.max(threshold + 1, alive.length))
  next = resolveVote(next, nominee.id, voteCount)
  return next
}

export function runFuzzSimulation(config: FuzzConfig): FuzzResult {
  const rng = mulberry32(config.seed)
  const trace: string[] = []
  let game = createFuzzGame(config.seed, config.playerCount)
  let stepsExecuted = 0

  const guard = (label: string) => {
    try {
      assertEngineInvariants(game)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Fuzz invariant failed (seed=${config.seed}, step=${stepsExecuted}, label=${label})\nTrace:\n${trace.join('\n')}\n${message}`,
      )
    }
  }

  for (let i = 0; i < config.maxSteps; i++) {
    const step = getNextStep(game)
    trace.push(`${i}:${step.type}`)

    if (step.type === 'game_over') break

    if (step.type === 'role_reveal') {
      game = markRoleRevealed(game, step.playerId)
      stepsExecuted++
      guard('role_reveal')
      continue
    }

    if (step.type === 'night_waiting') {
      const state = game.history.at(-1)?.stateAfter
      if (!state) break
      if (state.phase === 'setup' || state.phase === 'day') {
        game = startNight(game)
        stepsExecuted++
        guard('start_night')
        continue
      }
      if (state.phase === 'night') {
        game = startDay(game)
        stepsExecuted++
        guard('start_day')
        continue
      }
    }

    if (step.type === 'night_action' || step.type === 'night_action_skip') {
      if (
        step.type === 'night_action' &&
        rng() < 0.3 &&
        !step.systemStepId
      ) {
        const state = game.history.at(-1)?.stateAfter
        const source = state?.players.find((player) => player.id === step.playerId)
        if (source && getCurrentTeam(source) === 'demon') {
          game = tryResolveRandomKill(game, rng, source.id)
        }
      }
      game = skipNightAction(game, step.roleId, step.playerId, step.systemStepId)
      stepsExecuted++
      guard('night_step')
      continue
    }

    if (step.type === 'day') {
      if (rng() < 0.65) {
        game = tryRandomNomination(game, rng)
        stepsExecuted++
        guard('nomination_vote')
      }
      if (rng() < 0.45) {
        game = executeAtEndOfDay(game)
        stepsExecuted++
        guard('execute_end_of_day')
      }
      if (rng() < 0.6) {
        game = startNight(game)
        stepsExecuted++
        guard('day_to_night')
      }
      continue
    }
  }

  return {
    seed: config.seed,
    stepsExecuted,
    trace,
  }
}
