import { presentationForAuthError } from "./auth.js";

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : undefined;
}

function isNetworkTypeError(error) {
  return error instanceof TypeError || error?.name === "TypeError";
}

export function terminalErrorPresentation(error) {
  const code = errorCode(error);
  switch (code) {
    case "stale_session":
      return {
        code,
        message: "This terminal belongs to a prior node runtime. Open a new terminal explicitly.",
      };
    case "claude_unavailable":
      return {
        code,
        message: "Claude Code could not start in the node-owner context.",
      };
    case "session_capacity":
      return {
        code,
        message: "Relay has reached its terminal-session capacity. Close an unused terminal, then try again.",
      };
    case "input_backpressure":
      return {
        code,
        message: "Terminal input is temporarily backlogged. Relay will retry after its queue has capacity.",
      };
    case "input_delivery_lost":
      return {
        code,
        message: "Relay could not finish a previously queued input batch. Inspect the terminal before re-entering the command.",
      };
    case "pty_transport":
      return {
        code,
        message: "Relay's terminal transport is unavailable. Keep this terminal open while it recovers, then retry the action.",
      };
    default:
      if (isNetworkTypeError(error)) {
        return {
          code: "network_uncertain",
          message: "Network delivery to the Relay terminal is uncertain. Keep this terminal open and inspect it before retrying the action.",
        };
      }
      return presentationForAuthError(error);
  }
}

export function terminalInputRecovery(error) {
  const presentation = terminalErrorPresentation(error);
  if (error?.delivery === "not_queued") {
    return {
      ...presentation,
      message: "Relay's bounded browser input queue is full. This input was not queued; wait for it to drain, then re-enter it.",
    };
  }
  switch (presentation.code) {
    case "input_delivery_lost":
      return {
        ...presentation,
        message: "Relay reported that a previously queued input batch could not finish. Its terminal effect is uncertain; inspect the terminal before retrying the saved input.",
      };
    case "pty_transport":
      return {
        ...presentation,
        message: "Relay did not admit this input because the terminal transport is unavailable. The input is saved; wait for recovery, then retry it.",
      };
    case "network_uncertain":
      return {
        ...presentation,
        message: "Network delivery of this input is uncertain. Relay may already have received it; the input is saved, so inspect the terminal before retrying to avoid duplication.",
      };
    default:
      return {
        ...presentation,
        message: `${presentation.message} The input is saved until you retry it or discard it.`,
      };
  }
}
