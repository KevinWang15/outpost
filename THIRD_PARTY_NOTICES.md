# Third-party notices

Original Outpost source code and documentation are licensed under the
[MIT License](LICENSE). Third-party components retain their own licenses.

The application was initialized from KevinWang15's `ts-fullstack-starter`,
generator commit `260e5a088d8abeb6dbd2289f05d224cbe9f78ff8`.

## Fonts

The application uses native system font stacks and ships no font files.

## Dependencies

React, CodeMirror, Radix UI, Fastify, Ajv, xterm.js and Electron are distributed under MIT
licenses. Lucide uses the ISC license and includes Feather-derived icons under
the MIT license. dotenv uses the BSD 2-Clause license. Other installed packages
retain the license notices supplied with their distributions in `node_modules`.

## Chat mode

- The [Agent Client Protocol SDK](https://github.com/agentclientprotocol/typescript-sdk)
  (`@agentclientprotocol/sdk`) is distributed under the Apache License 2.0.
- Outpost Terminal bundles [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp)
  (Apache License 2.0), fetched at build time at the version and integrity in
  `shared/chatAgents.json`; its license is kept beside it in `machine/vendor/`.
  Codex itself is not bundled.
- The Claude Code chat adapter, [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
  (Apache License 2.0), depends on Anthropic's Claude Agent SDK, which is
  subject to Anthropic's terms. Outpost does not redistribute it: Required
  software downloads the official release onto your machine.

- Session avatars are drawn by [Boring Avatars](https://github.com/boringdesigners/boring-avatars)
  (`boring-avatars`, MIT License).
- The Claude Code, Codex, Kimi Code and DeepSeek marks (`shared/harnessMarks.ts`) are the
  monochrome icons from [Lobe Icons](https://github.com/lobehub/lobe-icons)
  (MIT License). The marks themselves belong to their owners.

## Logs

The Logs page embeds [log-viewer](https://github.com/KevinWang15/log-viewer)
(`@kevinwang15/log-viewer`, MIT License), served by the Outpost server with its
bundled web UI. It depends on Express, `ws` and `cors` (MIT Licenses).

## History search

- [Transformers.js](https://github.com/huggingface/transformers.js) is distributed
  under Apache License 2.0; [ONNX Runtime](https://github.com/microsoft/onnxruntime)
  is distributed under the MIT License.
- [sqlite-vec](https://github.com/asg017/sqlite-vec) supplies local vector search;
  its installed package retains its license notices.
- Semantic search uses the MIT-licensed
  [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)
  model, with the pinned [Xenova ONNX conversion](https://huggingface.co/Xenova/multilingual-e5-small).
  Model weights are cached separately from conversation data.

Desktop packages retain Electron’s LICENSE and LICENSES.chromium.html notices.
