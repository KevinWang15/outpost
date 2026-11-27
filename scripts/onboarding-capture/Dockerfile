# Repeatable Linux GUI container for regenerating all Outpost onboarding screenshots:
# - Web UI screenshots via Playwright Chromium against a real disposable Outpost server
# - Native Outpost Desktop screenshots via GPUI WgpuHeadlessRenderer on Mesa lavapipe + Xvfb
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-noto-core \
      git \
      libasound2-dev \
      libfontconfig1-dev \
      libfreetype6-dev \
      libglib2.0-dev \
      libssl-dev \
      libvulkan1 \
      libwayland-dev \
      libx11-dev \
      libx11-xcb-dev \
      libxcb-render0-dev \
      libxcb-shape0-dev \
      libxcb-xfixes0-dev \
      libxcb1-dev \
      libxkbcommon-dev \
      libxkbcommon-x11-dev \
      mesa-vulkan-drivers \
      openssh-client \
      pkg-config \
      python3 \
      rsync \
      tmux \
      xauth \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install Inter & JetBrains Mono for crisp web and native terminal typography.
RUN mkdir -p /usr/local/share/fonts/onboarding \
    && curl -fsSL "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip" -o /tmp/jbm.zip \
    && python3 -c "import zipfile, pathlib; z=zipfile.ZipFile('/tmp/jbm.zip'); [pathlib.Path('/usr/local/share/fonts/onboarding/' + pathlib.Path(n).name).write_bytes(z.read(n)) for n in z.namelist() if n.startswith('fonts/ttf/') and n.endswith('.ttf')]" \
    && rm -f /tmp/jbm.zip \
    && fc-cache -f

# Install stable Rust toolchain (edition 2024) for compiling the GPUI desktop screenshot harness.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable \
    && rustc --version && cargo --version

# Pre-install Playwright Chromium and its GUI system libraries matching the repo's version.
ARG PLAYWRIGHT_VERSION=1.63.0
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install chromium --with-deps

WORKDIR /work
