import type { TapCommandDefinition } from './definition'
import { healthCommand } from './health'

// The command registry — the single source of truth for the tap binding.
// Adding a subcommand is one sibling module plus its entry here.
export const tapCommands = {
  health: healthCommand,
} satisfies Record<string, TapCommandDefinition>
