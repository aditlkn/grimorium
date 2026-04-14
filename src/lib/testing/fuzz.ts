import {
  applyNightAction,
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
import { getAlivePlayers, type Game } from '../types'
import type { RoleId } from '../roles/types'
import { ROLE_TEST_CONTRACTS } from './roleContracts'
import { assertEngineInvariants } from './invariants'
import { deriveWakeOrderFromRoleIds } from '../scripts/wakeOrder'
import { createGame } from '../game'
import { buildTransformationStateChanges } from '../transformations'

export type FuzzConfig = {
  seed: number
  maxSteps: number
  playerCount?: number
}

export type FuzzResult = {
  seed: number
  stepsExecuted: number
  trace: string[]
  roleCoverage: Record<RoleId, number>
  uncoveredRoles: RoleId[]
}

export type FuzzCoverageSummary = {
  roleCoverage: Record<RoleId, number>
  uncoveredRoles: RoleId[]
}

const TRACE_TAIL_LIMIT = 40

function formatTraceTail(trace: string[]): string {
  const start = Math.max(0, trace.length - TRACE_TAIL_LIMIT)
  const tail = trace.slice(start)
  return tail.join('\n')
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

function toKnownRoleId(roleId: string): RoleId | null {
  return roleId in ROLE_TEST_CONTRACTS ? (roleId as RoleId) : null
}

function emptyCoverageMap(): Record<RoleId, number> {
  const roleIds = Object.keys(ROLE_TEST_CONTRACTS) as RoleId[]
  return Object.fromEntries(roleIds.map((roleId) => [roleId, 0])) as Record<
    RoleId,
    number
  >
}

function markCovered(
  roleCoverage: Record<RoleId, number>,
  roleId: string | null | undefined,
) {
  if (!roleId) return
  const known = toKnownRoleId(roleId)
  if (!known) return
  roleCoverage[known] += 1
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

function tryRandomNomination(
  game: Game,
  rng: () => number,
): { game: Game; coveredRoleIds: RoleId[] } {
  const state = game.history.at(-1)?.stateAfter
  if (!state) return { game, coveredRoleIds: [] }
  const alive = getAlivePlayers(state)
  if (alive.length < 2) return { game, coveredRoleIds: [] }

  const nominator = pickOne(rng, alive)
  const nomineePool = alive.filter((player) => player.id !== nominator.id)
  if (nomineePool.length === 0) return { game, coveredRoleIds: [] }
  const nominee = pickOne(rng, nomineePool)

  let next = nominate(game, nominator.id, nominee.id)
  const threshold = getVoteThreshold(next.history.at(-1)!.stateAfter)
  const voteCount = randomInt(rng, 0, Math.max(threshold + 1, alive.length))
  next = resolveVote(next, nominee.id, voteCount)
  return {
    game: next,
    coveredRoleIds: [
      toKnownRoleId(nominator.roleId),
      toKnownRoleId(nominee.roleId),
    ].filter(Boolean) as RoleId[],
  }
}

function tryRandomTransformation(
  game: Game,
  rng: () => number,
  sourcePlayerId: string,
): { game: Game; coveredRoleIds: RoleId[] } {
  const state = game.history.at(-1)?.stateAfter
  if (!state || state.players.length === 0) return { game, coveredRoleIds: [] }

  const source = state.players.find((player) => player.id === sourcePlayerId)
  const target = pickOne(rng, state.players)
  const currentRole = toKnownRoleId(target.roleId)
  if (!currentRole) return { game, coveredRoleIds: [] }

  const allRoles = Object.keys(ROLE_TEST_CONTRACTS) as RoleId[]
  const candidates = allRoles.filter((roleId) => roleId !== currentRole)
  if (candidates.length === 0) return { game, coveredRoleIds: [] }

  const newRole = pickOne(rng, candidates)
  const changes = buildTransformationStateChanges(state, {
    kind: 'role_change',
    source: {
      cause: 'fuzz_transform',
      playerId: sourcePlayerId,
      roleId: source ? source.roleId : undefined,
    },
    targets: [
      {
        playerId: target.id,
        newRoleId: newRole,
        reveal: 'pending',
        queuePolicy: 'skip_if_window_passed',
      },
    ],
  })

  return {
    game: applyNightAction(game, {
      entries: changes.entries,
      stateUpdates: changes.stateUpdates,
      addEffects: changes.addEffects,
      removeEffects: changes.removeEffects,
      changeRoles: changes.changeRoles,
      changeAlignments: changes.changeAlignments,
    }),
    coveredRoleIds: [
      ...(source ? [toKnownRoleId(source.roleId)] : []),
      currentRole,
      newRole,
    ].filter(Boolean) as RoleId[],
  }
}

function tryRandomStatusInjection(
  game: Game,
  rng: () => number,
  sourcePlayerId: string,
): { game: Game; coveredRoleIds: RoleId[] } {
  const state = game.history.at(-1)?.stateAfter
  if (!state || state.players.length === 0) return { game, coveredRoleIds: [] }

  const target = pickOne(rng, state.players)
  const source = state.players.find((player) => player.id === sourcePlayerId)
  const statusType = rng() < 0.5 ? 'poisoned' : 'drunk'
  const targetRole = toKnownRoleId(target.roleId)

  return {
    game: applyNightAction(game, {
      entries: [],
      addEffects: {
        [target.id]: [
          {
            type: statusType,
            sourcePlayerId,
            expiresAt: 'end_of_day',
          },
        ],
      },
    }),
    coveredRoleIds: [
      ...(source ? [toKnownRoleId(source.roleId)] : []),
      targetRole,
    ].filter(Boolean) as RoleId[],
  }
}

export function summarizeFuzzCoverage(results: FuzzResult[]): FuzzCoverageSummary {
  const summary = emptyCoverageMap()
  for (const result of results) {
    for (const [roleId, hits] of Object.entries(result.roleCoverage)) {
      const known = toKnownRoleId(roleId)
      if (!known) continue
      summary[known] += hits
    }
  }

  const uncoveredRoles = (Object.keys(summary) as RoleId[]).filter(
    (roleId) => summary[roleId] === 0,
  )

  return { roleCoverage: summary, uncoveredRoles }
}

export function runFuzzSimulation(config: FuzzConfig): FuzzResult {
  const rng = mulberry32(config.seed)
  const trace: string[] = []
  const roleCoverage = emptyCoverageMap()
  let game = createFuzzGame(config.seed, config.playerCount)
  let stepsExecuted = 0

  const guard = (label: string) => {
    try {
      assertEngineInvariants(game)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Fuzz invariant failed (seed=${config.seed}, step=${stepsExecuted}, label=${label})\nTraceTail(last ${TRACE_TAIL_LIMIT}):\n${formatTraceTail(trace)}\n${message}`,
      )
    }
  }

  for (let i = 0; i < config.maxSteps; i++) {
    const step = getNextStep(game)
    trace.push(`${i}:${step.type}`)

    if (step.type === 'game_over') break

    if (step.type === 'role_reveal') {
      const state = game.history.at(-1)?.stateAfter
      const player = state?.players.find((candidate) => candidate.id === step.playerId)
      markCovered(roleCoverage, player?.roleId)
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
      markCovered(roleCoverage, step.roleId)
      if (step.type === 'night_action' && !step.systemStepId) {
        const state = game.history.at(-1)?.stateAfter
        const source = state?.players.find((player) => player.id === step.playerId)
        if (rng() < 0.16) {
          const transformResult = tryRandomTransformation(game, rng, source?.id ?? step.playerId)
          game = transformResult.game
          for (const roleId of transformResult.coveredRoleIds) {
            markCovered(roleCoverage, roleId)
          }
        }
        if (rng() < 0.18) {
          const statusResult = tryRandomStatusInjection(game, rng, source?.id ?? step.playerId)
          game = statusResult.game
          for (const roleId of statusResult.coveredRoleIds) {
            markCovered(roleCoverage, roleId)
          }
        }
      }
      game = skipNightAction(game, step.roleId, step.playerId, step.systemStepId)
      stepsExecuted++
      guard('night_step')
      continue
    }

    if (step.type === 'day') {
      if (rng() < 0.65) {
        const nominationResult = tryRandomNomination(game, rng)
        game = nominationResult.game
        for (const roleId of nominationResult.coveredRoleIds) {
          markCovered(roleCoverage, roleId)
        }
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

  const uncoveredRoles = (Object.keys(roleCoverage) as RoleId[]).filter(
    (roleId) => roleCoverage[roleId] === 0,
  )

  return {
    seed: config.seed,
    stepsExecuted,
    trace,
    roleCoverage,
    uncoveredRoles,
  }
}
