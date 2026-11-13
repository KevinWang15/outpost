# A disposable SSH target. Sessions run as the unprivileged user `dev`; the
# test installs the built Outpost Terminal in its home. Python runs the
# fixture coding tools.
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd \
    && useradd --create-home --shell /bin/bash dev && install -d -m 700 -o dev -g dev /home/dev/.ssh /home/dev/.outpost /home/dev/.outpost/bin
COPY coding-tool-fixture.py /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude && cp /usr/local/bin/claude /usr/local/bin/codex && cp /usr/local/bin/claude /usr/local/bin/kimi
RUN su dev -c "git init -b main /home/dev/work && git -C /home/dev/work -c user.name=Fixture -c user.email=fixture@example.com commit --allow-empty -m 'Initial commit'"
CMD ["/usr/sbin/sshd", "-D", "-e", "-o", "PermitRootLogin=no", "-o", "PasswordAuthentication=no"]
