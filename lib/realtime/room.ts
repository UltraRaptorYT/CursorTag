import type { ClientRoomMessage, ServerRoomMessage } from "@/lib/realtime/types";

export type RoomConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

type RoomSocketOptions = {
  roomCode: string;
  role: "host" | "player";
  clientId: string;
  onMessage: (message: ServerRoomMessage) => void;
  onStatus: (status: RoomConnectionStatus) => void;
  onOpen?: () => void;
};

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 8_000;

export async function checkRoomExists(roomCode: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomCode)}/status`, {
    cache: "no-store",
    signal: controller.signal,
  }).finally(() => window.clearTimeout(timeout));
  if (!response.ok) throw new Error("Could not check the room");
  const result = (await response.json()) as { exists?: boolean };
  return result.exists === true;
}

function getRealtimeUrl(options: RoomSocketOptions) {
  const configuredUrl = process.env.NEXT_PUBLIC_CURSOR_TAG_WS_URL?.trim();
  if (!configuredUrl) return null;

  const url = new URL(configuredUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;

  url.pathname = `${url.pathname.replace(/\/$/, "")}/rooms/${encodeURIComponent(options.roomCode)}`;
  url.searchParams.set("role", options.role);
  url.searchParams.set("clientId", options.clientId);
  return url.toString();
}

export type RoomSocket = ReturnType<typeof createRoomSocket>;

export function createRoomSocket(options: RoomSocketOptions) {
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let connectionTimer: number | null = null;
  let reconnectAttempt = 0;
  let lastPongAt = Date.now();
  let intentionallyClosed = false;

  function send(message: ClientRoomMessage) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function clearConnectionTimers() {
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
    if (connectionTimer !== null) window.clearTimeout(connectionTimer);
    heartbeatTimer = null;
    connectionTimer = null;
  }

  function scheduleReconnect() {
    if (intentionallyClosed || reconnectTimer !== null) return;
    options.onStatus("reconnecting");
    const backoff = Math.min(500 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    const delay = backoff + Math.floor(Math.random() * 250);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (intentionallyClosed || socket?.readyState === WebSocket.OPEN) return;
    const endpoint = getRealtimeUrl(options);
    if (!endpoint) {
      options.onStatus("error");
      return;
    }

    options.onStatus(reconnectAttempt ? "reconnecting" : "connecting");
    socket = new WebSocket(endpoint);
    connectionTimer = window.setTimeout(
      () => socket?.close(4000, "Connection timed out"),
      10_000,
    );

    socket.addEventListener("open", () => {
      clearConnectionTimers();
      reconnectAttempt = 0;
      lastPongAt = Date.now();
      options.onStatus("connected");
      options.onOpen?.();
      heartbeatTimer = window.setInterval(() => {
        if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
          socket?.close(4000, "Heartbeat timed out");
          return;
        }
        send({
          type: "ping",
          payload: { id: crypto.randomUUID(), clientSentAt: performance.now() },
        });
      }, HEARTBEAT_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as ServerRoomMessage;
        if (message.type === "pong") lastPongAt = Date.now();
        options.onMessage(message);
      } catch {
        // Ignore malformed frames without interrupting motion input.
      }
    });

    socket.addEventListener("close", () => {
      clearConnectionTimers();
      socket = null;
      scheduleReconnect();
    });
    socket.addEventListener("error", () => socket?.close());
  }

  function reconnectNow() {
    if (intentionallyClosed || socket?.readyState === WebSocket.OPEN) return;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connect();
  }

  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", reconnectNow);
  connect();

  return {
    send,
    close() {
      intentionallyClosed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      clearConnectionTimers();
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", reconnectNow);
      socket?.close(1000, "Client closed");
      socket = null;
    },
  };
}
