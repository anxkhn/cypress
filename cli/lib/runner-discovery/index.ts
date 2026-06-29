import path from 'path'

import { RunnerDiscoveryError } from './record'
import type { LiveRunnerState, ReadyRunnerState, RunnerDiscoveryRecord } from './record'
import { isPidAlive, verifyRunnerRecord } from './liveness'
import { readRunnerRecords } from './store'

export { RunnerDiscoveryError, INSTANCES_DIRNAME } from './record'

export type { LiveRunnerState, ReadyRunnerState, RunnerDiscoveryErrorCode, RunnerDiscoveryRecord } from './record'

export { isPidAlive, verifyRunnerRecord } from './liveness'

export { getRunnerDiscoveryDir, pruneDeadDiscoveryRecords, readRunnerRecords } from './store'

export interface ListRunnerOptions {
  /** Optional pid filter; omitted lists every matching instance. */
  instance?: number
  probeTimeoutMs?: number
}

const matchesProject = (record: RunnerDiscoveryRecord, projectRoot: string): boolean => {
  return path.resolve(record.projectRoot) === path.resolve(projectRoot)
}

// An undefined instance does not constrain, so an absent `--instance` lists
// every pid.
const matchesInstance = (record: RunnerDiscoveryRecord, instance: number | undefined): boolean => {
  return instance === undefined || record.pid === instance
}

// A dead pid is skipped without a probe (it proves the writer is gone); the
// survivors carry the live browser CDP state from their probe response.
const probeMatches = async (matches: RunnerDiscoveryRecord[], probeTimeoutMs?: number): Promise<LiveRunnerState[]> => {
  const probed = await Promise.all(matches.map(async (record) => {
    return isPidAlive(record.pid) ? verifyRunnerRecord(record, probeTimeoutMs) : null
  }))

  return probed.filter((runner): runner is LiveRunnerState => runner !== null)
}

/**
 * Enumerate every verified-live Cypress runner, optionally narrowed to a
 * specific pid. "No runners" is a valid, empty list, never an error — this
 * backs the `instances` command.
 */
export const listLiveRunners = async (options: ListRunnerOptions = {}): Promise<LiveRunnerState[]> => {
  const records = await readRunnerRecords()

  const matches = records.filter((record) => matchesInstance(record, options.instance))

  return probeMatches(matches, options.probeTimeoutMs)
}

export type RunnerSelectionReason = 'explicit' | 'only' | 'cwd-match' | 'arbitrary'

export interface RunnerSelection {
  runner: ReadyRunnerState
  reason: RunnerSelectionReason
  candidateCount: number
}

export interface ResolveRunnerOptions {
  instance?: number
  cwd: string
  probeTimeoutMs?: number
}

// Phrase the filter that came up empty so the discovery errors name what the
// user actually asked for (a pid, or nothing in particular).
const describeFilter = (instance: number | undefined): string => {
  if (instance !== undefined) {
    return ` with pid ${instance}`
  }

  return ''
}

const lowestPid = (runners: LiveRunnerState[]): LiveRunnerState => {
  return [...runners].sort((a, b) => a.pid - b.pid)[0]
}

// Browser readiness is not a selection criterion — the caller requires it of
// whatever is chosen.
const selectRunner = (live: LiveRunnerState[], options: ResolveRunnerOptions): { runner: LiveRunnerState, reason: RunnerSelectionReason } => {
  if (live.length === 1) {
    const filtered = options.instance !== undefined

    return { runner: live[0], reason: filtered ? 'explicit' : 'only' }
  }

  const cwdMatches = live.filter((record) => matchesProject(record, options.cwd))

  if (cwdMatches.length > 0) {
    return { runner: lowestPid(cwdMatches), reason: 'cwd-match' }
  }

  return { runner: lowestPid(live), reason: 'arbitrary' }
}

export const resolveRunner = async (options: ResolveRunnerOptions): Promise<RunnerSelection> => {
  const { instance, probeTimeoutMs } = options
  const records = await readRunnerRecords()

  const matches = records.filter((record) => matchesInstance(record, instance))

  if (matches.length === 0) {
    throw new RunnerDiscoveryError(
      'NO_DISCOVERY_FILE',
      `No Cypress instance found${describeFilter(instance)}. This command requires Cypress running in open mode. Start Cypress in open mode, open a browser, and try again.`,
    )
  }

  const live = await probeMatches(matches, probeTimeoutMs)

  if (live.length === 0) {
    throw new RunnerDiscoveryError(
      'STALE_DISCOVERY_FILE',
      `Cypress was previously running${describeFilter(instance)}, but is no longer responding. Cypress likely exited uncleanly; start Cypress in open mode, open a browser, and try again.`,
    )
  }

  const { runner, reason } = selectRunner(live, options)

  if (!runner.cdpBrowserWsUrl) {
    throw new RunnerDiscoveryError(
      'NO_BROWSER_ATTACHED',
      `Cypress is running (pid ${runner.pid}, ${runner.projectRoot}), but no test browser is open. Open a browser in Cypress and try again.`,
    )
  }

  return { runner: runner as ReadyRunnerState, reason, candidateCount: live.length }
}
