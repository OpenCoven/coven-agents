import { createServer } from "node:http";

createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/internal/credential") {
    // A real COPILOT_GITHUB_TOKEN in the environment upgrades the harness
    // from mechanics-only to full missions; the stub default still exercises
    // every layer, ending in copilot's own auth refusal.
    response.end(
      JSON.stringify({
        credential:
          process.env.COPILOT_GITHUB_TOKEN ?? "stub-credential-not-real",
      })
    );
    return;
  }
  response.statusCode = 404;
  response.end("{}");
}).listen(9797, () => console.log("stub credential server on 9797"));
