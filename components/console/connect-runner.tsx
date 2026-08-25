// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Btn, Eyebrow } from "@/components/console/primitives";
import { hairline, type as type_ } from "@/components/console/styles";
import type { RunnerConnection } from "@/lib/agents/client";
import {
  type ConnectionStatusKind,
  connectionMessage,
} from "@/lib/agents/connection-status";

/**
 * Manual runner connection.
 *
 * The server provisions this for a subscriber, so the modal is the fallback,
 * not the path: it exists for a deployment with no runner configured, and for
 * pointing the console at a runner you are developing against.
 */

const inputStyle: React.CSSProperties = {
  background: "var(--bg-sunken)",
  border: hairline,
  borderRadius: "var(--radius-control)",
  color: "var(--text-primary)",
  font: "400 12px/1.4 var(--font-mono)",
  outline: "none",
  padding: "9px 11px",
  width: "100%",
};

export function ConnectRunner({
  connection,
  onCancel,
  onSave,
  status,
}: {
  connection: RunnerConnection;
  onCancel: () => void;
  onSave: (next: RunnerConnection) => void;
  status: ConnectionStatusKind;
}) {
  const [endpoint, setEndpoint] = useState(connection.endpoint);
  const [token, setToken] = useState(connection.token);
  // Closed on every mount rather than remembering the last choice: the point
  // is that opening this while sharing a screen does not put the deployment's
  // address on the recording.
  const [revealed, setRevealed] = useState(false);

  return (
    <div
      style={{
        alignItems: "center",
        background: "oklch(0 0 0 / 0.42)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        padding: 16,
        position: "absolute",
        zIndex: 70,
      }}
    >
      <div
        aria-labelledby="connect-runner-title"
        aria-modal="true"
        role="dialog"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-lg)",
          maxWidth: 520,
          padding: 20,
          width: "100%",
        }}
      >
        <Eyebrow>Cloud control plane</Eyebrow>
        <h2
          id="connect-runner-title"
          style={{ ...type_.display, fontSize: 22, margin: "8px 0 6px" }}
        >
          Connect a runner
        </h2>
        <p style={{ ...type_.body, font: "400 12px/1.6 var(--font-ui)" }}>
          {status === "provisioned"
            ? "This session is already provisioned from the server. Overriding it points the console somewhere else until you reload."
            : connectionMessage(status)}
        </p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            marginTop: 16,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <Eyebrow>Runner endpoint</Eyebrow>
            <span style={{ position: "relative" }}>
              <input
                onChange={(event) => setEndpoint(event.target.value)}
                style={{
                  ...inputStyle,
                  filter: revealed ? undefined : "blur(5px)",
                  paddingRight: 40,
                  userSelect: revealed ? "auto" : "none",
                }}
                value={endpoint}
              />
              <button
                aria-label={
                  revealed ? "Hide runner endpoint" : "Reveal runner endpoint"
                }
                onClick={() => setRevealed((value) => !value)}
                style={{
                  alignItems: "center",
                  background: "transparent",
                  border: 0,
                  bottom: 0,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "center",
                  position: "absolute",
                  right: 0,
                  top: 0,
                  width: 38,
                }}
                type="button"
              >
                {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </span>
            <span
              style={{
                color: "var(--text-muted)",
                font: "400 11px/1.5 var(--font-ui)",
              }}
            >
              Hidden by default so it does not end up in a screenshot. It is not
              a secret — the browser needs it to reach the runner, and every
              request is refused without the token below and an identity minted
              from your session.
            </span>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <Eyebrow>Runner token</Eyebrow>
            <input
              onChange={(event) => setToken(event.target.value)}
              style={inputStyle}
              type="password"
              value={token}
            />
          </label>
        </div>

        <div
          style={{
            display: "flex",
            gap: 9,
            justifyContent: "flex-end",
            marginTop: 18,
          }}
        >
          <Btn onClick={onCancel} variant="ghost">
            Cancel
          </Btn>
          <Btn
            disabled={!(endpoint.trim() && token.trim())}
            onClick={() =>
              onSave({ endpoint: endpoint.trim(), token: token.trim() })
            }
            variant="primary"
          >
            Connect
          </Btn>
        </div>
      </div>
    </div>
  );
}
