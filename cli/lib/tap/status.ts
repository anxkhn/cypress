import { RunnerDiscoveryError, resolveLiveRunner } from '../runner-discovery'
import type { ReadyRunnerState } from '../runner-discovery'
import { withTapSession, throwTapError, validateExecResult } from './tap-session'
import { renderKnownFailure, renderResult, renderStatusHelp } from './output'
import { TAP_EXEC_METHOD } from '@packages/runner-discovery'
import { errors } from '../errors'
import type { TapCliOptions } from '../exec/tap'

interface TapRunState {
  spec: string | null
  totalSpecs: number
  state?: 'running' | 'passed' | 'failed'
  totalTests?: number
  results?: { passed: number, failed: number, pending: number, skipped: number }
}

interface TapStatus {
  status: string
  pid?: number
  projectRoot?: string
  testingType?: 'e2e' | 'component' | null
  browserAttached?: boolean
  totalSpecs?: number
  spec?: string
  totalTests?: number
  results?: { passed: number, failed: number, pending: number, skipped: number }
}

const mergeRunState = (base: TapStatus, runState: TapRunState): TapStatus => {
  if (runState.state === undefined) {
    return { ...base, status: 'spec not selected', totalSpecs: runState.totalSpecs }
  }

  return {
    ...base,
    status: runState.state,
    totalSpecs: runState.totalSpecs,
    ...(runState.spec !== null ? { spec: runState.spec } : {}),
    totalTests: runState.totalTests,
    results: runState.results,
  }
}

export const reportStatus = async (options: TapCliOptions, wantsHelp: boolean): Promise<number> => {
  if (wantsHelp) {
    renderStatusHelp()

    return 0
  }

  let selection

  try {
    selection = await resolveLiveRunner({ instance: options.instance, cwd: process.cwd() })
  } catch (err) {
    // No live instance is a status a poller waits on, not a failure.
    if (err instanceof RunnerDiscoveryError) {
      renderResult({ status: 'not connected' } satisfies TapStatus)

      return 0
    }

    throw err
  }

  const { runner } = selection
  const browserAttached = runner.cdpBrowserWsUrl !== null

  const base: TapStatus = {
    status: 'browser not selected',
    pid: runner.pid,
    projectRoot: runner.projectRoot,
    testingType: runner.testingType,
    browserAttached,
  }

  if (!browserAttached) {
    renderResult(base)

    return 0
  }

  try {
    const runState = await withTapSession(runner as ReadyRunnerState, async (session) => {
      const outcome = validateExecResult(await session.call(TAP_EXEC_METHOD, ['run-state', {}, {}]))

      if (!outcome.ok) {
        // run-state has no domain failures, so a non-ok envelope means the
        // running Cypress lacks the command — a binding mismatch.
        return throwTapError(errors.tapInvalidExecResult, `${outcome.code}: ${outcome.message}`)
      }

      return outcome.result as TapRunState
    })

    renderResult(mergeRunState(base, runState))

    return 0
  } catch (err: any) {
    // Browser attached but runner unreachable (loading, tab closed, CDP gone) —
    // a transport fault, surfaced like other commands.
    if (err.known && err.details) {
      renderKnownFailure(err)

      return 1
    }

    throw err
  }
}
