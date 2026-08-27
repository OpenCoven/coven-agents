FROM docker.io/cloudflare/sandbox:0.12.7

# Coven Agents drives an already-signed-in coding CLI rather than calling a model
# provider, so the harness itself must exist in the image. The Worker holds no
# provider API key; the harness reads its own credential at run time.
RUN npm install -g pnpm@10.32.1 @github/copilot@1.0.80

WORKDIR /workspace
EXPOSE 8080
