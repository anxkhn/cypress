import Debug from 'debug'
import commander from 'commander'

import { RunnerDiscoveryError, listLiveRunners, resolveLiveRunner, resolveRunner } from '../runner-discovery'
import type { ReadyRunnerState } from '../runner-discovery'
import { withTapSession, throwTapError } from '../tap/tap-session'
import type { TapSession } from '../tap/tap-session'
import { buildTapProgram } from '../tap/build-program'
import { renderFailure, renderKnownFailure, renderInstancesHelp, renderResult, renderGenericHelp, renderSchemaHelp, renderStatusHelp } from '../tap/output'
import { TAP_EXEC_METHOD, TAP_PROTOCOL_VERSION, TAP_SCHEMA_METHOD } from '@packages/runner-discovery'
import type { TapExecResult, TapSchema } from '@packages/runner-discovery'
import { errors } from '../errors'

const debug = Debug('cypress:cli:tap')

interface TapCliOptions {
  instance?: number
}

const validateSchema = (value: unknown): TapSchema => {
  const schema = value as TapSchema | null | undefined

  if (!schema || typeof schema !== 'object' || typeof schema.protocolVersion !== 'number' || !Array.isArray(schema.commands)) {
    return throwTapError(errors.tapInvalidSchema, `${TAP_SCHEMA_METHOD} returned an unrecognizable schema.`)
  }

  if (schema.protocolVersion > TAP_PROTOCOL_VERSION) {
    return throwTapError(errors.tapUnsupportedProtocol, `schema protocol v${schema.protocolVersion} is newer than the CLI's v${TAP_PROTOCOL_VERSION}.`)
  }

  if (schema.protocolVersion < TAP_PROTOCOL_VERSION) {
    return throwTapError(errors.tapOutdatedProtocol, `schema protocol v${schema.protocolVersion} is older than the CLI's v${TAP_PROTOCOL_VERSION}.`)
  }

  return schema
}

const validateExecResult = (value: unknown): TapExecResult => {
  const outcome = value as TapExecResult | null | undefined

  if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
    return throwTapError(errors.tapInvalidExecResult, `${TAP_EXEC_METHOD} returned an unrecognizable result.`)
  }

  return outcome
}

const isHelpFlag = (arg: string): boolean => arg === '--help' || arg === '-h'

interface CommandInfo {
  wantsHelp: boolean
  positionals: string[]
  command: string | undefined
}

const buildCommandInfo = (operands: string[]): CommandInfo => {
  const wantsHelp = operands.some(isHelpFlag)
  const positionals = operands.filter((arg) => !isHelpFlag(arg))
  const command = positionals[0]

  return { wantsHelp, positionals, command }
}

const execCommand = async (session: TapSession, command: string, commandArgs: Record<string, string>, commandOptions: Record<string, string>): Promise<number> => {
  const outcome = validateExecResult(await session.call(TAP_EXEC_METHOD, [command, commandArgs, commandOptions]))

  if (!outcome.ok) {
    renderFailure(outcome)

    return 1
  }

  renderResult(outcome.result)

  return 0
}

const listInstances = async (options: TapCliOptions, wantsHelp: boolean): Promise<number> => {
  if (wantsHelp) {
    renderInstancesHelp()

    return 0
  }

  const runners = await listLiveRunners({ instance: options.instance })

  renderResult(runners.map((runner) => ({
    pid: runner.pid,
    projectRoot: runner.projectRoot,
    serverPort: runner.serverPort,
    browserAttached: runner.cdpBrowserWsUrl !== null,
  })))

  return 0
}

// The in-app run slice the `run-state` binding command returns — opaque JSON
// the CLI merges into the status, never interprets. `state` is present exactly
// when a spec is mounted (it gates the run-only fields); its absence is the
// spec-list stage.
interface TapRunState {
  spec: string | null
  totalSpecs: number
  state?: 'running' | 'passed' | 'failed'
  totalTests?: number
  results?: { passed: number, failed: number, pending: number, skipped: number }
}

// The status object rendered to stdout. A superset that grows as the instance
// advances through its lifecycle, so a poller reads one `status` field and the
// detail fills in. Identity fields are absent only for `not connected`.
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

// Fold the binding's run state into the discovery-derived base. No mounted spec
// (`state` absent) is the spec-list stage; otherwise the run `state` IS the
// reported status, with the active spec and result counts alongside.
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

/**
 * The CLI-native `status` command. Like `instances` it reports the discovery
 * layer and so must work before any browser exists; unlike it, it targets a
 * single resolved instance and — once a browser is attached — enriches the
 * report with the in-app run state from the `run-state` binding command.
 *
 * It is a reporter, not a gate: every determinable lifecycle stage (including
 * `not connected`) renders a status and exits 0, so polling scripts get a
 * stable success and branch on the JSON. Only a genuine transport fault (a
 * browser is attached but the runner is unreachable) exits non-zero.
 */
const reportStatus = async (options: TapCliOptions, wantsHelp: boolean): Promise<number> => {
  if (wantsHelp) {
    renderStatusHelp()

    return 0
  }

  let selection

  try {
    selection = await resolveLiveRunner({ project: options.project, instance: options.instance, cwd: process.cwd() })
  } catch (err) {
    // No live instance is itself a status a poller waits on, not a failure.
    if (err instanceof RunnerDiscoveryError) {
      renderResult({ status: 'not connected' } satisfies TapStatus)

      return 0
    }

    throw err
  }

  const { runner } = selection
  const browserAttached = runner.cdpBrowserWsUrl !== null
  // testingType joined the discovery record after this branch's base; read it
  // defensively and omit it until the field propagates up the stack.
  const testingType = (runner as { testingType?: 'e2e' | 'component' | null }).testingType

  const base: TapStatus = {
    status: 'browser not selected',
    pid: runner.pid,
    projectRoot: runner.projectRoot,
    ...(testingType !== undefined ? { testingType } : {}),
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
        // running Cypress lacks the command — a binding mismatch, not a stage.
        throw new TapTransportError('INVALID_EXEC_RESULT', `${outcome.code}: ${outcome.message}`)
      }

      return outcome.result as TapRunState
    })

    renderResult(mergeRunState(base, runState))

    return 0
  } catch (err: any) {
    // A browser is attached but the runner is unreachable (still loading, tab
    // closed, CDP gone) — a transport fault, surfaced like other commands.
    if (err instanceof TapTransportError) {
      renderFailure(err)

      return 1
    }

    throw err
  }
}

const tapModule = {
  async start (operands: string[] = [], options: TapCliOptions = {}): Promise<number> {
    debug('tap invocation %o with options %o', operands, options)

    const { wantsHelp, positionals, command } = buildCommandInfo(operands)

    if (command === 'instances') {
      return listInstances(options, wantsHelp)
    }

    // `status` is the CLI's other reserved command: it reports the discovery
    // layer (and the in-app run state when a browser is attached) and must work
    // before any browser exists, so it short-circuits before the session too.
    // (A running instance that advertised `status` would be shadowed here.)
    if (command === 'status') {
      return reportStatus(options, wantsHelp)
    }

    try {
      const selection = await resolveRunner({ instance: options.instance, cwd: process.cwd() })

      return await withTapSession(selection.runner, async (session) => {
        const schema = validateSchema(await session.call(TAP_SCHEMA_METHOD))

        let dispatchCode = 0
        const program = buildTapProgram(schema, async (name, args, options) => {
          dispatchCode = await execCommand(session, name, args, options)
        })

        if (wantsHelp || !command) {
          return renderSchemaHelp(program, schema, selection, command, wantsHelp)
        }

        try {
          await program.parseAsync(positionals, { from: 'user' })
        } catch (err: any) {
          if (err instanceof commander.CommanderError) {
            return 1
          }

          throw err
        }

        return dispatchCode
      })
    } catch (err: any) {
      if (err instanceof RunnerDiscoveryError) {
        if ((wantsHelp || !command) && err.code === 'NO_DISCOVERY_FILE') {
          return renderGenericHelp(wantsHelp)
        }

        debug('tap %s failed: %s %s', command || '(help)', err.code, err.message)
        renderFailure(err)

        return 1
      }

      if (err.known && err.details) {
        debug('tap %s failed: %s', command || '(help)', err.message)
        renderKnownFailure(err)

        return 1
      }

      throw err
    }
  },
}

export default tapModule
