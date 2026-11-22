# Outpost machine service 3.0.4

Linux builds are available for x64 and arm64 with glibc or musl. Machine nodes and native terminal workers use protocol 8. ACP chat hosts use protocol 3.

- Native terminal workers accept a scrollback line limit or unlimited history from Outpost Desktop. The default is 10,000 lines. Each viewer restores the amount it requests. Opening a viewer with a smaller limit preserves the history available to other viewers.
- A running worker keeps its scrollback in memory while every viewer is disconnected. Restarting the worker clears its terminal history. Restart workers from an earlier release to use the new scrollback settings.

- **Connect over SSH** checks the execution account and selected tools, transfers the verified service and opens the machine protocol on SSH stdin and stdout. SSH bastions and offline tool packages are supported.
- **Run setup on the machine** enrolls a supervised outbound connection with a single-use code. The same node handles terminal attachments, files, ACP, Chat, schedules and history.
- If an outbound enrollment is interrupted, rerunning setup with the same server and machine completes the original claim. Status shows a pending enrollment until setup finishes.
- Terminal and Chat sessions expose the same Outpost MCP tools for file transfer and agent communication.
- Each Linux host has one enrollment. Use `outpost-terminal status` to inspect it and `outpost-terminal unenroll` to release it. Closing an attachment leaves the session running on its machine.
- Session status stays available when a coding tool exits during a status check.
