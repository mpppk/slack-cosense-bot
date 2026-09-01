# Sandbox SDK container image.
#
# The stock cloudflare/sandbox image ships Node.js 20, but @helpfeel/cosense-cli
# requires Node 24+. So we start from node:24-slim and copy in the sandbox
# binary, which is the documented way to add sandbox capabilities to an
# arbitrary base image.
#
# The sandbox binary version MUST match the @cloudflare/sandbox package
# version in package.json — the SDK checks this on startup and warns on drift.
FROM node:24-slim

ARG BUN_VERSION=1.4.0

ENV BUN_INSTALL=/root/.bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" \
    && bun --version \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/cloudflare/sandbox:0.12.9 /container-server/sandbox /sandbox

# cosense CLI is baked into the image rather than installed at runtime: the
# container is shared process-wide and long-lived (決定事項: コンテナは全体で1本共有),
# so paying the install cost at build time keeps the first request after a cold
# start fast. `cosense --version` fails the build rather than the first message.
RUN bun add --global @helpfeel/cosense-cli@1.14.1 && cosense --version

ENTRYPOINT ["/sandbox"]
