# Outpost machine service 3.0.3

Linux builds are available for x64 and arm64 with glibc or musl. Machine nodes and native terminal workers use protocol 7. ACP chat hosts use protocol 3.

- Native terminal agents receive channel attachment IDs. A file published during their reply is attached to that reply. Restart a native terminal worker from an earlier release to use the new delivery protocol.
- Concurrent transfers keep separate file handles. Closing the machine connection discards unfinished uploads.
- An interrupted outbound installation leaves the verified service available for inspection, retry and unenrollment. Enabling the boot service and releasing the enrollment are serialized.

- **Connect over SSH** checks the execution account and selected tools, transfers the verified service and opens the machine protocol on SSH stdin and stdout. SSH bastions and offline tool packages are supported.
- **Run setup on the machine** enrolls a supervised outbound connection with a single-use code. The same node handles terminal attachments, files, ACP, Chat, schedules and history.
- If an outbound enrollment is interrupted, rerunning setup with the same server and machine completes the original claim. Status shows a pending enrollment until setup finishes.
- Terminal and Chat sessions expose the same Outpost MCP tools for file transfer and agent communication.
- Each Linux host has one enrollment. Use `outpost-terminal status` to inspect it and `outpost-terminal unenroll` to release it. Closing an attachment leaves the session running on its machine.
- Session status stays available when a coding tool exits during a status check.
