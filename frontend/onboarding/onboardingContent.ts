// Structured copy, core terminology, and screenshot definitions for the Outpost Onboarding Guide.
// Intentionally focuses on Machines, Sessions, Outpost Desktop, Web Terminal, and Machine CLI.

export type OnboardingStepId =
  'welcome' | 'install-desktop' | 'connect-desktop' | 'add-machine' | 'start-session' | 'connect-and-work'

export interface OnboardingTerm {
  id: string
  term: string
  summary: string
  detail: string
}

export interface OnboardingScreenshot {
  filename: string
  caption: string
  badge?: string
}

export interface OnboardingStepMeta {
  id: OnboardingStepId
  number: number
  navLabel: string
  title: string
  subtitle: string
  screenshots: OnboardingScreenshot[]
}

export const DESKTOP_RELEASES_URL = 'https://github.com/KevinWang15/outpost/releases'

export const ONBOARDING_TERMS: readonly OnboardingTerm[] = [
  {
    id: 'machine',
    term: 'Machine',
    summary: 'Your Linux host',
    detail:
      'Any Linux workstation, VM, cloud server, or WSL2 instance where your repositories, credentials, and coding tools live. Outpost installs a single lightweight service (outpost-terminal) there.',
  },
  {
    id: 'session',
    term: 'Session',
    summary: 'A persistent AI coding workspace',
    detail:
      'Bound to one project directory and one coding agent (Claude Code, Codex, Kimi Code, Antigravity CLI, or DeepSeek Harness). Sessions stay alive on the Linux machine even if you close your laptop or lose Wi-Fi.',
  },
  {
    id: 'desktop',
    term: 'Outpost Desktop',
    summary: 'Native terminal for macOS & Windows',
    detail:
      'A GPU-accelerated native terminal workspace combining your local shells and remote Outpost sessions in tabs and split panes, with screenshot paste, scrollback search, and live agent status badges.',
  },
  {
    id: 'web-terminal',
    term: 'Web terminal',
    summary: 'Zero-install browser terminal',
    detail:
      'Attach to the exact same running session from any desktop or mobile browser. Closing a browser tab or native window only disconnects the view—the agent keeps running.',
  },
  {
    id: 'machine-cli',
    term: 'Machine CLI (outpost)',
    summary: 'Launch sessions from any shell',
    detail:
      'Installed alongside the machine service so you can run `outpost new` or `outpost ls` directly in a Linux shell and automatically open the session in a new Outpost tab.',
  },
]

export const ONBOARDING_STEPS: readonly OnboardingStepMeta[] = [
  {
    id: 'welcome',
    number: 1,
    navLabel: 'What is Outpost?',
    title: 'Welcome to Outpost',
    subtitle:
      'Run persistent AI coding agents on your own Linux machines and reconnect to them seamlessly from a native terminal or any browser.',
    screenshots: [
      {
        filename: 'web-workspace.png',
        badge: 'Outpost Web',
        caption: 'Your Machines view shows each connected Linux host, installed coding tools, and live AI sessions.',
      },
    ],
  },
  {
    id: 'install-desktop',
    number: 2,
    navLabel: 'Install Outpost Desktop',
    title: 'Install the native terminal',
    subtitle:
      'Outpost Desktop gives you native tabs, split panes, local shells, screenshot paste, and instant switching across all your remote AI sessions.',
    screenshots: [
      {
        filename: 'desktop-connect-server.png',
        badge: 'Outpost Desktop',
        caption:
          'Outpost Desktop opens to a clean workspace ready to connect to your Outpost server or launch local shells.',
      },
    ],
  },
  {
    id: 'connect-desktop',
    number: 3,
    navLabel: 'Connect Desktop to Outpost',
    title: 'Connect Outpost Desktop to this server',
    subtitle:
      'Sign in once through your browser so Outpost Desktop can browse machines, create sessions, and attach terminals securely for 30 days.',
    screenshots: [
      {
        filename: 'desktop-connect-server.png',
        badge: 'Step 1 · App',
        caption:
          'Paste your Outpost server URL under Connect a server and click Sign in with browser (or launch directly from here).',
      },
      {
        filename: 'web-desktop-authorize.png',
        badge: 'Step 2 · Browser',
        caption: 'Confirm the server and account in your browser, then click Connect app to approve access.',
      },
      {
        filename: 'desktop-connected.png',
        badge: 'Step 3 · Connected',
        caption:
          'Once approved, the server appears under Logged-in Outpost servers with quick access to Machines, New session, and Recent sessions.',
      },
    ],
  },
  {
    id: 'add-machine',
    number: 4,
    navLabel: 'Add a Linux Machine',
    title: 'Add your first Linux machine',
    subtitle:
      'Connect any Linux workstation, cloud VM, or WSL2 host over SSH or an outbound HTTPS tunnel—your code and API keys never leave that machine.',
    screenshots: [
      {
        filename: 'web-add-machine.png',
        badge: 'Add a machine',
        caption:
          'Choose Connect over SSH for reachable hosts, or Run setup on the machine for hosts behind NAT or a firewall.',
      },
      {
        filename: 'web-workspace.png',
        badge: 'Software readiness',
        caption:
          'Outpost inspects your Linux PATH and lets you install missing coding tools with one click from the Software panel.',
      },
    ],
  },
  {
    id: 'start-session',
    number: 5,
    navLabel: 'Start an AI Session',
    title: 'Start your first AI coding session',
    subtitle:
      'Pick a machine, a coding tool, and a project directory. You can create sessions from the web UI, directly inside Outpost Desktop, or via `outpost new`.',
    screenshots: [
      {
        filename: 'web-new-session.png',
        badge: 'Web UI',
        caption:
          'Click New session on any ready machine, choose your coding tool (Claude Code, Codex, Kimi Code, or Antigravity CLI), and pick a directory.',
      },
      {
        filename: 'desktop-create-session.png',
        badge: 'Outpost Desktop',
        caption:
          'You can also create remote sessions directly inside Outpost Desktop with remote directory autocomplete.',
      },
    ],
  },
  {
    id: 'connect-and-work',
    number: 6,
    navLabel: 'Connect & Split Panes',
    title: 'Connect and work across split panes',
    subtitle:
      'Attach to any session in Outpost Desktop or the Web terminal. Combine local shells and multiple remote AI agents side by side.',
    screenshots: [
      {
        filename: 'web-connect-dialog.png',
        badge: 'Connect',
        caption:
          'Click Connect on any session to open it in Outpost Desktop or the zero-install Web terminal (and optionally remember your preference).',
      },
      {
        filename: 'desktop-session-picker.png',
        badge: 'Quick picker',
        caption:
          'In Outpost Desktop, click + or press Ctrl+Shift+O (Cmd+Shift+O on macOS) to search and open sessions across all machines.',
      },
      {
        filename: 'desktop-split-workspace.png',
        badge: 'Split panes',
        caption:
          'Run multiple AI agents and local shells in tabs and split panes with live working/idle/finished status badges.',
      },
    ],
  },
]

export const ALL_ONBOARDING_SCREENSHOT_FILES: readonly string[] = [
  ...new Set(ONBOARDING_STEPS.flatMap(step => step.screenshots.map(shot => shot.filename))),
]
