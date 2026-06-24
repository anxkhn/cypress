import type { TapCommandDefinition } from './definition'
import { healthCommand } from './health'
import { specsCommand } from './specs'

// The command registry — the single source of truth for the tap binding.
// Adding a subcommand is one sibling module plus its entry here.
export const tapCommands = {
  health: healthCommand,
  specs: specsCommand,
} satisfies Record<string, TapCommandDefinition>
