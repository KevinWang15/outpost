# A disposable SSH target with the oldest supported tmux (3.2a) and Python 3.10.
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server python3 tmux ca-certificates \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh
COPY coding-tool-fixture.py /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude && cp /usr/local/bin/claude /usr/local/bin/codex && cp /usr/local/bin/claude /usr/local/bin/kimi
CMD ["/usr/sbin/sshd", "-D", "-e", "-o", "PermitRootLogin=prohibit-password", "-o", "PasswordAuthentication=no"]
