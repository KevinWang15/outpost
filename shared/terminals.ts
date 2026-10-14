/** Both choices use the same terminal UI and wire protocol. */
export const terminalChoices = ['web', 'desktop'] as const
export type TerminalChoice = (typeof terminalChoices)[number]
