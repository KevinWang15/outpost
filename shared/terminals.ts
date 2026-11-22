/** The browser and native terminals attach to the same persistent sessions. */
export const terminalChoices = ['web', 'desktop'] as const
export type TerminalChoice = (typeof terminalChoices)[number]
