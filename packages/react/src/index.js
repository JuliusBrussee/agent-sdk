"use client";

/**
 * A React client for a Caveman agent server.
 *
 * The server this talks to is `createAgentServer` from `@caveman-ai/agent`,
 * whose `/runs` endpoint requires a bearer token it describes as spending money
 * and returning model output. That token belongs on your server, never in a
 * bundle, so `useAgent` has no token or absolute-origin option: it calls a
 * same-origin path in YOUR app. `useSession` also supports direct hosts and
 * accepts a short-lived token; the README documents that sharper boundary.
 *
 * Everything on the wire is a frozen Pebble v1 `TurnEvent`, so this file only
 * folds events into render state. It invents no fields and reports what it does
 * not know as unknown rather than as zero.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createBatcher } from "./batch.js";
import {
  INITIAL_STATE,
  SESSION_INITIAL_STATE,
  reduceAgentEvent,
  reduceSessionEvent,
} from "./events.js";

export {
  INITIAL_STATE,
  SESSION_INITIAL_STATE,
  reduceAgentEvent,
  reduceSessionEvent,
} from "./events.js";

/**
 * Dereferenced on call, never at import: this module renders on the server in
 * every framework that server-renders client components, and `requestAnimationFrame`
 * is not defined there. Nothing schedules until an event actually arrives, which
 * only happens in a browser.
 */
const scheduleFrame = (flush) => globalThis.requestAnimationFrame(flush);

/**
 * Submit one run and stream its events.
 *
 * @param {{ api: string }} options `api` is a same-origin base path your app
 *   serves, e.g. `/api/agent`. It must proxy `POST /runs` and
 *   `GET /runs/:id/events` to the agent server with the bearer token attached.
 */
export function useAgent({ api }) {
  if (typeof api !== "string" || api === "") {
    throw new Error("cave_react_api_required: pass the same-origin base path your app proxies");
  }
  const [state, setState] = useState(INITIAL_STATE);
  const [runId, setRunId] = useState(null);
  const sourceRef = useRef(null);
  /**
   * Which attach the hook is currently on. `submit` awaits a network round trip
   * before it can open a stream, and anything the caller does in the meantime —
   * a second submit, a `watch`, a `stopWatching` — supersedes it. The bump is
   * what stops that stale submit from resurrecting its own state or leaving a
   * second EventSource open behind the current one.
   */
  const attach = useRef(0);
  const batchRef = useRef(null);
  batchRef.current ??= createBatcher(setState, scheduleFrame);
  const batch = batchRef.current;

  const disconnect = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  /** Abandon the current attach: close its stream and drop its unapplied events. */
  const detach = useCallback(() => {
    attach.current += 1;
    disconnect();
    batch.cancel();
    return attach.current;
  }, [disconnect, batch]);

  // A hook unmounted mid-run must not leave an open connection behind. The run
  // itself keeps going and stays journaled; only this view of it stops.
  useEffect(() => detach, [detach]);

  /**
   * Open the event stream for a run already known to the server.
   *
   * `EventSource` reconnects transport failures on its own and resumes from
   * `Last-Event-ID`, which the server answers with the exact span this client
   * missed — so the retry path is the platform's, not ours.
   */
  const connect = useCallback((id, generation) => {
    const source = new EventSource(`${api}/runs/${encodeURIComponent(id)}/events`, {
      withCredentials: true,
    });
    sourceRef.current = source;

    /**
     * Read one frame, or fail the turn.
     *
     * Returns null once it has reported the failure. A frame this client cannot
     * parse is a hole in the transcript, and the transcript is what the UI
     * renders — so the stream stops rather than rendering the rest as if
     * nothing were missing. It arrives over a proxy route the app writes, which
     * makes it a trust boundary and not an impossible case.
     */
    const frame = (message) => {
      if (attach.current !== generation) return null;
      try {
        return JSON.parse(message.data);
      } catch {
        disconnect();
        batch.push((previous) => ({
          ...previous,
          status: "error",
          error: { message: "cave_react_event_unparsable", retryable: false },
        }));
        return null;
      }
    };

    source.onmessage = (message) => {
      const event = frame(message);
      if (event === null) return;
      batch.push((previous) => reduceAgentEvent(previous, event));
      // The server ends the response after turn.end. Closing here is what stops
      // EventSource from reading that as a drop and reconnecting to a finished
      // run; without it the client would reopen the stream forever. It runs now
      // rather than at the next flush so no reconnect races the batch.
      if (event.kind === "turn.end") disconnect();
    };
    // The server could not replay a span this client missed. Surfaced rather
    // than smoothed over: the transcript below has a hole in it.
    source.addEventListener("gap", (message) => {
      const detail = frame(message);
      if (detail === null) return;
      batch.push((previous) => ({ ...previous, gap: detail }));
    });
    // Only a closed source is terminal; everything else EventSource retries.
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED || attach.current !== generation) return;
      sourceRef.current = null;
      batch.push((previous) => previous.status === "streaming"
        ? {
            ...previous,
            status: "error",
            error: { message: "cave_react_stream_closed", retryable: true },
          }
        : previous);
    };
  }, [api, disconnect, batch]);

  /** Start showing `id` from the beginning, discarding whatever preceded it. */
  const begin = useCallback((id) => {
    const generation = detach();
    setRunId(id);
    setState({ ...INITIAL_STATE, status: "streaming" });
    return generation;
  }, [detach]);

  const submit = useCallback(async (input) => {
    if (typeof input !== "string" || input === "") {
      throw new Error("cave_react_input_required");
    }
    const id = crypto.randomUUID();
    const generation = begin(id);

    let accepted;
    try {
      accepted = await fetch(`${api}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ runId: id, input }),
      });
    } catch (error) {
      // Offline, or the proxy route is unreachable. Left unhandled this would
      // reject out of an onClick and strand the UI on "streaming" forever.
      if (attach.current === generation) {
        batch.push((previous) => ({
          ...previous,
          status: "error",
          error: { message: `submit failed: ${String(error)}`, retryable: true },
        }));
      }
      return id;
    }
    // Superseded while the request was in flight: this run was still admitted,
    // and `watch(id)` can pick it up, but it is no longer what the caller shows.
    if (attach.current !== generation) return id;
    if (!accepted.ok) {
      const detail = await accepted.text();
      // Reading the body is another await, and another chance to be superseded.
      if (attach.current !== generation) return id;
      batch.push((previous) => ({
        ...previous,
        status: "error",
        error: { message: `submit failed: ${accepted.status} ${detail}`, retryable: false },
      }));
      return id;
    }
    connect(id, generation);
    return id;
  }, [api, begin, connect, batch]);

  /**
   * Attach to a run this hook did not submit — after a reload, or from another
   * tab. The server replays the run's events from the beginning, so the state
   * this rebuilds is the same one an uninterrupted stream would have produced.
   *
   * Its event window is bounded and in-memory: a run that settled long ago, or
   * one whose events an instance restart discarded, has no stream left to
   * attach to and surfaces as a closed stream. `GET /runs/:id` is the record.
   */
  const watch = useCallback((id) => {
    if (typeof id !== "string" || id === "") {
      throw new Error("cave_react_run_id_required");
    }
    connect(id, begin(id));
  }, [begin, connect]);

  /**
   * Stop watching without cancelling. `DELETE /runs/:id` exists, but this
   * view-only method deliberately does not call it. Reattach with `watch(runId)`.
   */
  const stopWatching = useCallback(() => {
    detach();
    setState((previous) => previous.status === "streaming"
      ? { ...previous, status: "detached" }
      : previous);
  }, [detach]);

  return { ...state, runId, submit, watch, stopWatching };
}

function sessionPath(url, sessionId, suffix = "") {
  return `${url.replace(/\/$/u, "")}/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

function bearerProtocol(token) {
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `cave-bearer.${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "")}`;
}

/** Parse complete SSE frames from a mutable text buffer. */
function takeSseFrames(buffer, receive, gap) {
  let boundary = buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    if (!frame.startsWith(":")) {
      const data = /^data: (.+)$/mu.exec(frame)?.[1];
      if (data !== undefined) {
        const parsed = JSON.parse(data);
        if (/^event: gap$/mu.test(frame)) gap(parsed);
        else receive(parsed);
      }
    }
    boundary = buffer.indexOf("\n\n");
  }
  return buffer;
}

/**
 * Attach to a durable multi-run session over SSE or WebSocket.
 * Token may be short-lived or injected by a same-origin proxy; never hard-code it.
 */
export function useSession({ url, sessionId, token, transport = "sse" }) {
  if (typeof url !== "string" || url === "") throw new Error("cave_react_session_url_required");
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("cave_react_session_id_required");
  }
  if (typeof token !== "string" || token === "") throw new Error("cave_react_session_token_required");
  if (transport !== "sse" && transport !== "ws") {
    throw new Error("cave_react_session_transport_invalid");
  }
  const [state, setState] = useState(SESSION_INITIAL_STATE);
  const transportRef = useRef(null);
  const stopped = useRef(false);
  const batchRef = useRef(null);
  batchRef.current ??= createBatcher(setState, scheduleFrame);
  const batch = batchRef.current;

  const fail = useCallback((message) => {
    batch.push((previous) => ({ ...previous, status: "error", error: message }));
  }, [batch]);
  const receive = useCallback((event) => {
    batch.push((previous) => reduceSessionEvent(previous, event));
  }, [batch]);

  useEffect(() => {
    stopped.current = false;
    batch.cancel();
    setState(SESSION_INITIAL_STATE);
    if (transport === "ws") {
      if (typeof WebSocket === "undefined") {
        fail("cave_react_session_websocket_unavailable");
        return undefined;
      }
      const endpoint = new URL(sessionPath(url, sessionId, "/ws"), globalThis.location?.href);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(endpoint, ["caveman-agent", bearerProtocol(token)]);
      transportRef.current = socket;
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data);
          if (event?.error === "cave_serve_events_gap") fail(event.error);
          else receive(event);
        } catch { fail("cave_react_event_unparsable"); }
      };
      socket.onerror = () => fail("cave_react_session_websocket_failed");
      socket.onclose = () => {
        if (!stopped.current) fail("cave_react_stream_closed");
      };
      return () => {
        stopped.current = true;
        socket.close();
        transportRef.current = null;
        batch.cancel();
      };
    }

    const controller = new AbortController();
    transportRef.current = controller;
    void (async () => {
      let lastEventId;
      while (!controller.signal.aborted) {
        const endpoint = new URL(sessionPath(url, sessionId, "/events"), globalThis.location?.href);
        if (lastEventId !== undefined) endpoint.searchParams.set("lastEventId", lastEventId);
        let response;
        try {
          response = await fetch(endpoint, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
        } catch (error) {
          if (!controller.signal.aborted) fail(`cave_react_session_fetch_failed:${String(error)}`);
          return;
        }
        if (!response.ok || response.body === null) {
          fail(`cave_react_session_fetch_failed:${response.status}`);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            buffer += decoder.decode(next.value, { stream: true });
            buffer = takeSseFrames(buffer, (event) => {
              lastEventId = String(event.seq);
              receive(event);
            }, (detail) => fail(detail.error ?? "cave_serve_events_gap"));
          }
        } catch (error) {
          if (!controller.signal.aborted) fail(`cave_react_stream_closed:${String(error)}`);
          return;
        }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    return () => {
      stopped.current = true;
      controller.abort();
      transportRef.current = null;
      batch.cancel();
    };
  }, [url, sessionId, token, transport, receive, fail, batch]);

  const send = useCallback(async (text, options = {}) => {
    if (typeof text !== "string" || text === "") throw new Error("cave_react_input_required");
    const payload = { type: "message", text, ...options };
    if (transport === "ws") {
      const socket = transportRef.current;
      if (!(socket instanceof WebSocket) || socket.readyState !== WebSocket.OPEN) {
        throw new Error("cave_react_session_socket_not_open");
      }
      socket.send(JSON.stringify(payload));
      return undefined;
    }
    const response = await fetch(sessionPath(url, sessionId, "/messages"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text, ...options }),
    });
    if (!response.ok) throw new Error(`cave_react_session_send_failed:${response.status}`);
    return response.json();
  }, [url, sessionId, token, transport]);

  const cancel = useCallback(async () => {
    const response = await fetch(sessionPath(url, sessionId), {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`cave_react_session_cancel_failed:${response.status}`);
    stopped.current = true;
    if (transportRef.current instanceof AbortController) transportRef.current.abort();
    else transportRef.current?.close();
    batch.push((previous) => ({ ...previous, status: "cancelled" }));
  }, [url, sessionId, token, batch]);

  return { events: state.events, send, cancel, status: state.status };
}
