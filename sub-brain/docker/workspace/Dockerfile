# WeBrain workspace image
#
# Base: ubuntu:24.04 (LTS). Used by the DockerSandbox workspace mode
# (see sub-brain/src/sandbox/docker-sandbox.ts, Round J2).
#
# Goals
#   1. Real apt for `apt-get install <anything>` on top of a curated baseline.
#   2. Python 3.12 + pip + venv for ML / data scripts.
#   3. Node 22 LTS for JS skill execution / npm.
#   4. Build toolchain so `pip install <native ext>` doesn't fail.
#   5. A non-root `agent` user — agents drop privileges by default; if they
#      need root they can `sudo apt-get install` (passwordless sudo is on for
#      the agent user, the trust boundary is the container itself).
#
# Size budget: target ~700-900 MB compressed. We trade size for capability.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Single RUN layer for the base toolchain. Order: refresh apt → install →
# clean up apt caches so the image stays lean.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget git jq less vim nano \
        build-essential pkg-config make \
        python3 python3-pip python3-venv python3-dev \
        nodejs npm \
        ffmpeg imagemagick \
        unzip zip tar gzip xz-utils \
        sqlite3 \
        sudo openssh-client \
        locales tzdata \
    && locale-gen C.UTF-8 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Non-root agent user with passwordless sudo. Trust boundary is the
# container, not the user inside it — privilege drop is a defense-in-depth
# measure against scripts that assume root by accident.
RUN useradd --create-home --shell /bin/bash --uid 1000 agent && \
    echo 'agent ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/agent && \
    chmod 0440 /etc/sudoers.d/agent

# Friendly defaults for the interactive shell (history, pip cache, etc.)
RUN mkdir -p /home/agent/.config /home/agent/.cache /workspace && \
    chown -R agent:agent /home/agent /workspace

# Keep the python3 symlink resolution stable across base-image upgrades.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python && \
    ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /workspace
USER agent

# Health probe — used by docker_sandbox sanity checks.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=2 \
    CMD test -d /workspace || exit 1

# Default to an idle keep-alive. DockerSandbox.ensureWorkspace() runs
# `sh -c "sleep infinity"` explicitly, so this CMD is only here for the
# `docker run webrain-workspace:latest` ergonomic case.
CMD ["sleep", "infinity"]
