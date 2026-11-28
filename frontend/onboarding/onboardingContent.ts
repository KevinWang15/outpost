// Copy, terminology, shortcuts and screenshot definitions for the onboarding guide.
// Covers machines, sessions, Outpost Desktop, the Web terminal and the Machine CLI.
// Text may use `code` and **strong** marks; see renderInline in OnboardingSteps.tsx.

export type OnboardingStepId =
  'welcome' | 'install-desktop' | 'connect-desktop' | 'add-machine' | 'start-session' | 'connect-and-work'

export interface OnboardingTerm {
  id: string
  term: string
  detail: string
}

/** Where a screenshot's subject sits, so the inline view can crop to it.
 * `x` and `y` are the percentages of the image that stay fixed while it is enlarged `zoom` times. */
export interface OnboardingFocus {
  x: number
  y: number
  zoom: number
}

export interface OnboardingScreenshot {
  filename: string
  /** Short tab label, used when a step shows several screenshots. */
  label: string
  /** What the picture shows, for readers who cannot see it. */
  alt: string
  caption: string
  focus?: OnboardingFocus
}

export interface OnboardingStepMeta {
  id: OnboardingStepId
  navLabel: string
  title: string
  lead: string
  screenshots: OnboardingScreenshot[]
}

export interface OnboardingShortcut {
  id: string
  label: string
  mac: readonly string[]
  other: readonly string[]
}

export const DESKTOP_RELEASES_URL = 'https://github.com/KevinWang15/outpost/releases'

export const ONBOARDING_TERMS: readonly OnboardingTerm[] = [
  {
    id: 'machine',
    term: 'Machine',
    detail:
      'A Linux computer where your repositories and coding tools live: a workstation, a VM, a server or WSL. Outpost runs a small service on it.',
  },
  {
    id: 'session',
    term: 'Session',
    detail:
      'One coding tool working in one project directory. It runs on the machine and keeps running when you disconnect.',
  },
  {
    id: 'desktop',
    term: 'Outpost Desktop',
    detail:
      'A native terminal app for macOS and Windows. It opens your local shells and your Outpost sessions in tabs and split panes.',
  },
  {
    id: 'web-terminal',
    term: 'Web terminal',
    detail: 'The same session in a browser tab, on a computer or a phone, with nothing to install.',
  },
  {
    id: 'machine-cli',
    term: 'Machine CLI',
    detail:
      'The `outpost` command on each machine. Run `outpost new` in a project directory to start a session from any shell.',
  },
]

/** Outpost Desktop shortcuts, as listed in docs/guide/04-terminals.md. */
export const ONBOARDING_SHORTCUTS: readonly OnboardingShortcut[] = [
  {
    id: 'sessions-picker',
    label: 'Find and open any session',
    mac: ['⌘', '⇧', 'O'],
    other: ['Ctrl', 'Shift', 'O'],
  },
  {
    id: 'split',
    label: 'Split the pane side by side',
    mac: ['⌘', 'D'],
    other: ['Ctrl', 'Shift', 'D'],
  },
  {
    id: 'find',
    label: 'Search the scrollback',
    mac: ['⌘', 'F'],
    other: ['Ctrl', 'Shift', 'F'],
  },
  {
    id: 'paste-image',
    label: 'Paste a screenshot for the agent',
    mac: ['⌘', 'V'],
    other: ['Ctrl', 'V'],
  },
]

export const ONBOARDING_STEPS: readonly OnboardingStepMeta[] = [
  {
    id: 'welcome',
    navLabel: 'What is Outpost?',
    title: 'Welcome to Outpost',
    lead: 'Outpost runs coding agents on your own Linux machines. Each session keeps running there, so you can close your laptop and pick it up later from any device.',
    screenshots: [
      {
        filename: 'web-workspace.png',
        label: 'Machines',
        alt: 'The Machines page showing a machine named Workstation, its five coding tools and three sessions.',
        caption: 'The Machines page lists each machine with its coding tools and its sessions.',
      },
    ],
  },
  {
    id: 'install-desktop',
    navLabel: 'Install Outpost Desktop',
    title: 'Install Outpost Desktop',
    lead: 'Outpost Desktop is a native terminal for macOS and Windows. Your local shells and your Outpost sessions share one window, with tabs, split panes and screenshot paste.',
    screenshots: [
      {
        filename: 'desktop-connect-server.png',
        label: 'First launch',
        alt: 'Outpost Desktop on first launch, with an Open local terminal button and a Connect a server field.',
        caption: 'Outpost Desktop on first launch, before any server is connected.',
        focus: { x: 50, y: 30, zoom: 1.3 },
      },
    ],
  },
  {
    id: 'connect-desktop',
    navLabel: 'Connect Outpost Desktop',
    title: 'Connect Outpost Desktop to this server',
    lead: 'Approve the app once in your browser. It can then list, create and open your sessions on this server for 30 days. Sign-in happens in the browser, so the app never handles a password.',
    screenshots: [
      {
        filename: 'desktop-connect-server.png',
        label: 'In the app',
        alt: 'Outpost Desktop with a server address entered under Connect a server, next to a Sign in with browser button.',
        caption: 'The server address under Connect a server, ready for Sign in with browser.',
        focus: { x: 50, y: 89, zoom: 1.45 },
      },
      {
        filename: 'web-desktop-authorize.png',
        label: 'In your browser',
        alt: 'A browser page asking “Connect Outpost Desktop?” with Cancel and Connect app buttons.',
        caption: 'The approval page names the server and the account before you choose Connect app.',
        focus: { x: 50, y: 50, zoom: 1.75 },
      },
      {
        filename: 'desktop-connected.png',
        label: 'Connected',
        alt: 'Outpost Desktop listing recent sessions and a signed-in server with Machines, New session and Sign out buttons.',
        caption: 'The server now appears under Logged-in Outpost servers, with your recent sessions above it.',
        focus: { x: 50, y: 89, zoom: 1.45 },
      },
    ],
  },
  {
    id: 'add-machine',
    navLabel: 'Add a machine',
    title: 'Add a machine',
    lead: 'A machine is the Linux computer where your sessions run, next to your repositories and coding tools. Choose the connection that matches your network.',
    screenshots: [
      {
        filename: 'web-add-machine.png',
        label: 'Add a machine',
        alt: 'The Add a machine dialog with two methods, Connect over SSH and Run setup on the machine.',
        caption: 'Add a machine explains both methods and what each one needs.',
        focus: { x: 50, y: 50, zoom: 1.45 },
      },
      {
        filename: 'web-workspace.png',
        label: 'Software',
        alt: 'A machine page whose Software panel reads “Ready · 5 of 5 coding tools available”.',
        caption: 'The Software panel shows which coding tools the machine has. Expand it to set up the others.',
        focus: { x: 100, y: 0, zoom: 1.25 },
      },
    ],
  },
  {
    id: 'start-session',
    navLabel: 'Start a session',
    title: 'Start a session',
    lead: 'A session is one coding tool working in one project directory. It runs on the machine and keeps going after you disconnect.',
    screenshots: [
      {
        filename: 'web-new-session.png',
        label: 'In the browser',
        alt: 'The New session dialog with a name, a coding tool selected and a project directory.',
        caption: 'New session asks for a name, a coding tool and a project directory.',
        focus: { x: 50, y: 0, zoom: 1.3 },
      },
      {
        filename: 'desktop-create-session.png',
        label: 'In Outpost Desktop',
        alt: 'The New session form in Outpost Desktop with a machine, a coding tool, a name and a working directory.',
        caption: 'Outpost Desktop has the same form and completes directory names from the machine.',
        focus: { x: 50, y: 18, zoom: 1.3 },
      },
    ],
  },
  {
    id: 'connect-and-work',
    navLabel: 'Connect and work',
    title: 'Connect and work',
    lead: '**Connect** opens a session in Outpost Desktop or the Web terminal. Both attach to the same running session, so you can switch between them at any time.',
    screenshots: [
      {
        filename: 'web-connect-dialog.png',
        label: 'Connect',
        alt: 'The Connect dialog offering the Web terminal and Outpost Desktop, with a Remember my choice checkbox.',
        caption: 'Connect offers both terminals and can remember your choice.',
        focus: { x: 50, y: 50, zoom: 1.6 },
      },
      {
        filename: 'desktop-session-picker.png',
        label: 'Sessions picker',
        alt: 'The Outpost sessions picker in Outpost Desktop, listing sessions from several machines with a search field.',
        caption: 'The sessions picker in Outpost Desktop searches the sessions on every connected server.',
        focus: { x: 50, y: 35, zoom: 1.4 },
      },
      {
        filename: 'desktop-split-workspace.png',
        label: 'Split panes',
        alt: 'Outpost Desktop with two coding agents working side by side in split panes, each tab showing a status icon.',
        caption: 'Two agents side by side. Each tab and pane header shows whether its agent is working or needs you.',
        focus: { x: 0, y: 0, zoom: 1.12 },
      },
    ],
  },
]

export const ALL_ONBOARDING_SCREENSHOT_FILES: readonly string[] = [
  ...new Set(ONBOARDING_STEPS.flatMap(step => step.screenshots.map(shot => shot.filename))),
]
