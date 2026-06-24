import type { SerializedTest } from '@packages/types'

// Optional fields throughout are absent rather than null: JSON drops undefined
// keys at the CDP boundary, so the in-memory shape already equals the wire form.

export interface TestStateEntry {
  id: string
  title: string
  duration?: number
  state: string
  /** Retries actually taken this run, not the configured maximum. */
  retries?: number
}

export interface TestError {
  name?: string
  message?: string
  stack?: string
}

export interface TestDetailEntry {
  id: string
  title: string
  /** Suite titles leading to this test plus its own, joined with ` > `. */
  fullTitle: string
  duration?: number
  state: string
  retries?: number
  timings?: Record<string, unknown>
  error?: TestError
}

export interface CommandEntry {
  id: string
  name?: string
  message?: string
  state?: string
  /** `parent` | `child` | `dual`. */
  type?: string
}

/**
 * `getTestsState(testId)` serializes the run's tests up to (excluding) the one
 * whose id matches, so a never-matching sentinel yields every test.
 */
export interface TapTestsRunner {
  getTestsState (testId?: string): Record<string, SerializedTest>
}

/**
 * Seam over the driver runner the tap commands read (component tests stub it).
 * The instance comes from the event manager, not `window.Cypress`: when the
 * runner page is itself an AUT (cypress-in-cypress), `window.Cypress` is the
 * outer driver injected into it, while the event manager only holds this app's.
 */
export const tapRunnerSource = {
  getRunner (): TapTestsRunner | undefined {
    try {
      // Both a throw and undefined here mean there is no run to read yet.
      return window.getEventManager?.().getCypress()?.runner
    } catch {
      return undefined
    }
  },
}

export const serializeTestsState = (runner: TapTestsRunner): TestStateEntry[] => {
  // '__never__' matches no id, so every test is serialized (see TapTestsRunner).
  const tests = Object.values(runner.getTestsState('__never__'))

  return tests.map(({ id, title, duration, state, currentRetry }): TestStateEntry => {
    return {
      id,
      title,
      ...(duration !== undefined ? { duration } : {}),
      ...(state !== undefined ? { state } : { state: 'pending' }),
      ...(currentRetry !== undefined ? { retries: currentRetry } : {}),
    }
  })
}

const serializeTestError = (err: Record<string, unknown>): TestError => {
  const { name, message, stack } = err

  return {
    ...(name !== undefined ? { name: name as string } : {}),
    ...(message !== undefined ? { message: message as string } : {}),
    ...(stack !== undefined ? { stack: stack as string } : {}),
  }
}

export const serializeTestDetail = (runner: TapTestsRunner, testId: string): TestDetailEntry | undefined => {
  // Pass the sentinel, not testId: getTestsState excludes the matching id, so
  // the wanted test would never be in the result (see TapTestsRunner).
  const test = runner.getTestsState('__never__')[testId]

  if (!test) {
    return undefined
  }

  const { id, title, duration, state, currentRetry } = test
  const titlePath = test._titlePath as string[] | undefined
  const timings = test.timings as Record<string, unknown> | undefined
  const err = test.err as Record<string, unknown> | undefined

  return {
    id,
    title,
    fullTitle: Array.isArray(titlePath) ? titlePath.join(' > ') : title,
    ...(duration !== undefined ? { duration } : {}),
    ...(state !== undefined ? { state } : { state: 'pending' }),
    ...(currentRetry !== undefined ? { retries: currentRetry } : {}),
    ...(timings !== undefined ? { timings } : {}),
    ...(err !== undefined ? { error: serializeTestError(err) } : {}),
  }
}

export const serializeTestCommands = (runner: TapTestsRunner, testId: string): CommandEntry[] | undefined => {
  // Pass the sentinel, not testId: getTestsState excludes the matching id, so
  // the wanted test would never be in the result (see TapTestsRunner).
  const test = runner.getTestsState('__never__')[testId]

  if (!test) {
    return undefined
  }

  const commands = (test.commands ?? []) as Array<Record<string, unknown>>

  return commands.map(({ id, name, message, state, type }): CommandEntry => {
    return {
      id: id as string,
      ...(name !== undefined ? { name: name as string } : {}),
      ...(message !== undefined ? { message: message as string } : {}),
      ...(state !== undefined ? { state: state as string } : {}),
      ...(type !== undefined ? { type: type as string } : {}),
    }
  })
}

export interface RunResults {
  passed: number
  failed: number
  pending: number
  skipped: number
}

export const aggregateResults = (runner: TapTestsRunner): { results: RunResults, totalTests: number } => {
  const tests = Object.values(runner.getTestsState('__never__'))
  const results: RunResults = { passed: 0, failed: 0, pending: 0, skipped: 0 }

  for (const test of tests) {
    // The serialized type enumerates only passed/failed/pending, but the driver
    // also marks tests 'skipped' at runtime, so widen before comparing.
    const state = test.state as string | undefined

    if (state === 'passed') {
      results.passed++
    } else if (state === 'failed') {
      results.failed++
    } else if (state === 'skipped') {
      results.skipped++
    } else {
      // No state yet (not run) or an explicit 'pending' both count as pending,
      // matching serializeTestsState's default.
      results.pending++
    }
  }

  return { results, totalTests: tests.length }
}
