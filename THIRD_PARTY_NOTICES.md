# Third-party notices

Original Outpost source code and documentation are licensed under the
[MIT License](LICENSE). Third-party components retain their own licenses.

The application was initialized from KevinWang15's `ts-fullstack-starter`,
generator commit `260e5a088d8abeb6dbd2289f05d224cbe9f78ff8`.

## Fonts

Promo font files are distributed under the SIL Open Font License 1.1:

- Inter: [license](promo-v2/assets/fonts/LICENSE-Inter.txt).
- JetBrains Mono: [license](promo-v2/assets/fonts/LICENSE-JetBrainsMono.txt).

The application itself uses native system font stacks.

## Dependencies

React, CodeMirror, Radix UI, Fastify, Ajv, xterm.js, Electron, and Three.js are distributed under MIT
licenses. Lucide uses the ISC license and includes Feather-derived icons under
the MIT license. dotenv uses the BSD 2-Clause license. Other installed packages
retain the license notices supplied with their distributions in `node_modules`.

## Chat mode

- The [Agent Client Protocol SDK](https://github.com/agentclientprotocol/typescript-sdk)
  (`@agentclientprotocol/sdk`) is distributed under the Apache License 2.0.
- Outpost Terminal bundles [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp)
  (Apache License 2.0), fetched at build time at the version and integrity in
  `shared/chatAgents.json`; its license is kept beside it in `terminal-service/vendor/`.
  Codex itself is not bundled.
- The Claude Code chat adapter, [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
  (Apache License 2.0), depends on Anthropic's Claude Agent SDK, which is
  subject to Anthropic's terms. Outpost does not redistribute it: Required
  Software downloads the official release onto your target.

- Session avatars are drawn by [Boring Avatars](https://github.com/boringdesigners/boring-avatars)
  (`boring-avatars`, MIT License).
- The Claude Code, Codex and Kimi marks (`frontend/ui/ToolIcon.tsx`) are the
  monochrome icons from [Lobe Icons](https://github.com/lobehub/lobe-icons)
  (MIT License). The marks themselves belong to their owners.

## Generated promo media

Generated narration, music, and movie files are excluded from Git and are not
covered by Outpost's source-code license. They may be kept in local checkouts.
Their publication and redistribution require a separate rights check for the
provider, generation plan, and intended use.

Desktop packages retain Electron’s LICENSE and LICENSES.chromium.html notices.
