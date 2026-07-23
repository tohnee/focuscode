FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bash ca-certificates git openssh-client python3 python3-pip ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && groupadd --gid 1000 focuscode \
    && useradd --uid 1000 --gid focuscode --create-home --shell /bin/bash focuscode

WORKDIR /workspace
USER focuscode
ENV HOME=/tmp CI=1

ENTRYPOINT []
CMD ["/bin/sh"]
