FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server python3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh
COPY coding-tool-fixture.py /usr/local/bin/codex
RUN chmod +x /usr/local/bin/codex && cp /usr/local/bin/codex /usr/local/bin/kimi && cp /usr/local/bin/codex /usr/local/bin/claude
CMD ["/usr/sbin/sshd", "-D", "-e", "-o", "PermitRootLogin=prohibit-password", "-o", "PasswordAuthentication=no"]
