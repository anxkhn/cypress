import { tapCommands } from './commands'
import { TapCommandError } from './commands/definition'
import type { TapCommandDefinition } from './commands/definition'
import { coerceCommandArgs, coerceCommandOptions } from './exec-args'
import { TAP_PROTOCOL_VERSION } from './contract'
import type { TapBindingContract, TapExecResult, TapSchema } from './contract'

// Normalize a wire payload to a plain object, or null if malformed. `null` maps
// to `{}` (absent); a primitive or array would otherwise slip past `Object.keys`
// with no keys and validate silently, so reject it as null.
const asWireRecord = (value: unknown): Record<string, string> | null => {
  if (value == null) {
    return {}
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, string>
}

// The surface mounted at `window.__CYPRESS_TAP_BINDING__`, invoked by the CLI
// over CDP `Runtime.callFunctionOn` — both methods are async and JSON-only per `./contract`.
export class TapManager implements TapBindingContract {
  constructor (private cypressVersion: string) {}

  async getSchema (): Promise<TapSchema> {
    return {
      protocolVersion: TAP_PROTOCOL_VERSION,
      cypressVersion: this.cypressVersion,
      commands: Object.entries(tapCommands).map(([name, definition]) => {
        // Widen past the `satisfies` literal type so the optional `options` is readable.
        const { description, params, options } = definition as TapCommandDefinition

        // Snapshot the arrays and their elements so a caller mutating the
        // returned schema can't reach back into the in-process registry.
        return {
          name,
          description,
          params: params.map((param) => ({ ...param })),
          options: (options ?? []).map((option) => ({ ...option })),
        }
      }),
    }
  }

  // The single dispatch entry point. `args`/`options` arrive as raw-string maps
  // keyed by schema name, are coerced here, then passed to the handler. Dispatch
  // and domain failures both resolve as `ok: false`; any other throw propagates.
  async exec (command: string, args: Record<string, string> = {}, options: Record<string, string> = {}): Promise<TapExecResult> {
    // Own-property lookup: `command` is wire input, so an inherited name
    // like "constructor" must not resolve to a prototype member.
    const definition: TapCommandDefinition | undefined = Object.prototype.hasOwnProperty.call(tapCommands, command)
      ? tapCommands[command as keyof typeof tapCommands]
      : undefined

    if (!definition) {
      return {
        ok: false,
        code: 'UNKNOWN_COMMAND',
        message: `"${command}" is not a command of this Cypress (v${this.cypressVersion}). Available commands: ${Object.keys(tapCommands).join(', ')}.`,
      }
    }

    const normalizedArgs = asWireRecord(args)
    const normalizedOptions = asWireRecord(options)

    if (!normalizedArgs || !normalizedOptions) {
      const field = normalizedArgs ? 'options' : 'args'

      return {
        ok: false,
        code: 'INVALID_ARGUMENTS',
        message: `"${command}" received a non-object ${field} payload; expected an object keyed by name.`,
      }
    }

    const optionSchema = definition.options ?? []

    const coercedArgs = coerceCommandArgs(command, definition.params, normalizedArgs, optionSchema)

    if (!coercedArgs.ok) {
      return { ok: false, code: 'INVALID_ARGUMENTS', message: coercedArgs.message }
    }

    const coercedOptions = coerceCommandOptions(command, definition.params, optionSchema, normalizedOptions)

    if (!coercedOptions.ok) {
      return { ok: false, code: 'INVALID_ARGUMENTS', message: coercedOptions.message }
    }

    try {
      return { ok: true, result: await definition.handler(coercedArgs.args, coercedOptions.options) }
    } catch (err) {
      // A handler's TapCommandError is a domain failure; surface it as ok: false.
      // Any other throw is a real binding bug.
      if (err instanceof TapCommandError) {
        return { ok: false, code: err.code, message: err.message }
      }

      throw err
    }
  }
}
