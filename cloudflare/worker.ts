import { DurableObject } from "cloudflare:workers";

import { GAME_CONFIG, PLAYER_COLORS } from "../lib/game/config";
import type {
  ClientRoomMessage,
  CursorPosition,
  RoomPlayer,
  RoomSnapshot,
  ServerRoomMessage,
} from "../lib/realtime/types";

type SocketAttachment = {
  role: "host" | "player";
  clientId: string;
  player?: RoomPlayer;
};

type StoredRoom = Omit<RoomSnapshot, "hostConnected"> & {
  aspectRatio: number;
};

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
const MAX_MESSAGE_BYTES = 2_048;

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function randomIndex(length: number) {
  if (length <= 1) return 0;
  const ceiling = Math.floor(256 / length) * length;
  const bytes = new Uint8Array(1);
  do crypto.getRandomValues(bytes);
  while (bytes[0] >= ceiling);
  return bytes[0] % length;
}

function randomRoundDurationMs() {
  const span = GAME_CONFIG.maxRoundSeconds - GAME_CONFIG.minRoundSeconds + 1;
  return (GAME_CONFIG.minRoundSeconds + randomIndex(span)) * 1_000;
}

function clampPosition(position: CursorPosition): CursorPosition {
  return {
    x: Math.max(0.025, Math.min(0.975, Number(position.x))),
    y: Math.max(0.04, Math.min(0.96, Number(position.y))),
  };
}

function defaultRoom(): StoredRoom {
  return {
    phase: "lobby",
    players: [],
    itPlayerId: null,
    round: 0,
    roundEndsAt: null,
    roundDurationMs: null,
    freezeUntil: null,
    frozenPlayerIds: [],
    impact: null,
    maxPlayers: GAME_CONFIG.maxPlayers,
    collisionRadius: GAME_CONFIG.collisionRadius,
    aspectRatio: 16 / 9,
  };
}

export class GameRoom extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Expected a WebSocket upgrade" }, 426);
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const clientId = url.searchParams.get("clientId")?.slice(0, 100);
    if ((role !== "host" && role !== "player") || !clientId) {
      return jsonResponse({ error: "Missing role or clientId" }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    for (const existing of this.ctx.getWebSockets(role)) {
      const attachment = existing.deserializeAttachment() as SocketAttachment | null;
      if (role === "host" || attachment?.clientId === clientId) {
        existing.close(4001, "Connection replaced");
      }
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, clientId } satisfies SocketAttachment);

    const state = this.loadState();
    this.send(server, {
      type: "connected",
      payload: { clientId, snapshot: this.snapshot(state) },
    });
    this.broadcastSnapshot(state);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer) {
    const size =
      typeof rawMessage === "string"
        ? new TextEncoder().encode(rawMessage).byteLength
        : rawMessage.byteLength;
    if (typeof rawMessage !== "string" || size > MAX_MESSAGE_BYTES) {
      this.send(socket, { type: "error", message: "Invalid message" });
      return;
    }

    let message: ClientRoomMessage;
    try {
      message = JSON.parse(rawMessage) as ClientRoomMessage;
    } catch {
      this.send(socket, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (message.type === "ping") {
      this.send(socket, {
        type: "pong",
        payload: { ...message.payload, serverSentAt: Date.now() },
      });
      return;
    }

    const attachment = socket.deserializeAttachment() as SocketAttachment;
    if (attachment.role === "host") {
      await this.handleHostMessage(message);
    } else {
      await this.handlePlayerMessage(socket, attachment, message);
    }
  }

  async webSocketClose(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const state = this.loadState();

    if (attachment?.role === "player" && attachment.player) {
      const storedPlayer = state.players.find(
        (player) => player.id === attachment.player?.id,
      );
      const disconnected = {
        ...attachment.player,
        score: storedPlayer?.score ?? attachment.player.score,
        connected: false,
      };
      state.players = this.mergePlayers(state).map((player) =>
        player.id === disconnected.id ? disconnected : player,
      );

      if (state.phase === "playing" && state.itPlayerId === disconnected.id) {
        this.assignReplacementIt(state, disconnected.id);
      }

      this.saveState(state);
    }

    this.broadcastSnapshot(state);
  }

  webSocketError(socket: WebSocket) {
    socket.close(1011, "Socket error");
  }

  async alarm() {
    const state = this.loadState();
    if (
      state.phase !== "playing" ||
      !state.roundEndsAt ||
      Date.now() + 25 < state.roundEndsAt
    ) {
      if (state.roundEndsAt) await this.ctx.storage.setAlarm(state.roundEndsAt);
      return;
    }
    await this.handleTimeout(state);
  }

  private async handleHostMessage(message: ClientRoomMessage) {
    const state = this.loadState();

    if (message.type === "request-snapshot") {
      this.broadcastSnapshot(state);
      return;
    }

    if (message.type === "host-viewport") {
      const aspectRatio = Number(message.payload.aspectRatio);
      if (Number.isFinite(aspectRatio)) {
        state.aspectRatio = Math.max(0.5, Math.min(3, aspectRatio));
        this.saveState(state);
      }
      return;
    }

    if (message.type === "host-start") {
      const eligible = this.mergePlayers(state).filter(
        (player) => player.connected && player.calibrated,
      );
      if (eligible.length < GAME_CONFIG.minPlayers) {
        this.sendToHosts({
          type: "error",
          message: `At least ${GAME_CONFIG.minPlayers} calibrated players are required`,
        });
        return;
      }

      const duration = randomRoundDurationMs();
      state.phase = "playing";
      state.players = this.mergePlayers(state).map((player) => ({ ...player, score: 0 }));
      state.itPlayerId = eligible[randomIndex(eligible.length)].id;
      state.round = 1;
      state.roundDurationMs = duration;
      state.roundEndsAt = Date.now() + duration;
      state.freezeUntil = null;
      state.frozenPlayerIds = [];
      state.impact = null;
      state.aspectRatio = Math.max(
        0.5,
        Math.min(3, Number(message.payload.aspectRatio) || 16 / 9),
      );
      this.saveState(state);
      await this.ctx.storage.setAlarm(state.roundEndsAt);
      this.broadcastSnapshot(state);
      return;
    }

    if (message.type === "host-end") {
      state.phase = "finished";
      state.roundEndsAt = null;
      state.roundDurationMs = null;
      state.freezeUntil = null;
      state.frozenPlayerIds = [];
      this.saveState(state);
      await this.ctx.storage.deleteAlarm();
      this.broadcastSnapshot(state);
      return;
    }

    if (message.type === "host-reset") {
      const next = defaultRoom();
      next.players = this.mergePlayers(state).map((player) => ({
        ...player,
        score: 0,
      }));
      next.aspectRatio = state.aspectRatio;
      this.saveState(next);
      await this.ctx.storage.deleteAlarm();
      this.broadcastSnapshot(next);
    }
  }

  private async handlePlayerMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: ClientRoomMessage,
  ) {
    const state = this.loadState();

    if (message.type === "request-snapshot") {
      this.send(socket, { type: "snapshot", payload: this.snapshot(state) });
      return;
    }

    if (message.type === "join") {
      const cleanName = message.payload.name.trim().replace(/\s+/g, " ").slice(0, 18);
      if (!cleanName) return;

      const currentPlayers = this.mergePlayers(state);
      const existing = currentPlayers.find((player) => player.id === attachment.clientId);
      if (!existing && currentPlayers.length >= this.maxPlayers()) {
        this.send(socket, { type: "error", message: "This room is full" });
        return;
      }

      const usedColors = new Set(currentPlayers.map((player) => player.color));
      const color =
        existing?.color ??
        PLAYER_COLORS.find((candidate) => !usedColors.has(candidate)) ??
        PLAYER_COLORS[currentPlayers.length % PLAYER_COLORS.length];
      const player: RoomPlayer = {
        id: attachment.clientId,
        name: cleanName,
        color,
        connected: true,
        calibrated: existing?.calibrated ?? false,
        position: existing?.position ?? {
          x: 0.3 + (currentPlayers.length % 4) * 0.13,
          y: 0.4 + Math.floor(currentPlayers.length / 4) * 0.2,
        },
        score: existing?.score ?? 0,
      };
      socket.serializeAttachment({ ...attachment, player });
      state.players = currentPlayers.some((candidate) => candidate.id === player.id)
        ? currentPlayers.map((candidate) => (candidate.id === player.id ? player : candidate))
        : [...currentPlayers, player];
      this.saveState(state);
      this.broadcastSnapshot(state);
      return;
    }

    if (!attachment.player) return;

    if (message.type === "calibrated") {
      const player = { ...attachment.player, calibrated: true, connected: true };
      socket.serializeAttachment({ ...attachment, player });
      state.players = this.mergePlayers(state).map((candidate) =>
        candidate.id === player.id ? player : candidate,
      );

      if (state.phase === "playing" && !state.itPlayerId) {
        this.assignReplacementIt(state);
      }
      this.saveState(state);
      if (state.roundEndsAt) await this.ctx.storage.setAlarm(state.roundEndsAt);
      this.broadcastSnapshot(state);
      return;
    }

    if (message.type !== "cursor") return;
    const now = Date.now();
    if (state.phase !== "playing") return;

    if (state.roundEndsAt && now >= state.roundEndsAt) {
      await this.handleTimeout(state);
      return;
    }

    if (
      state.freezeUntil &&
      now < state.freezeUntil &&
      state.frozenPlayerIds.includes(attachment.player.id)
    ) {
      return;
    }

    const position = clampPosition(message.payload);
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
    const player = { ...attachment.player, connected: true, position };
    socket.serializeAttachment({ ...attachment, player });

    const cursorMessage: ServerRoomMessage = {
      type: "cursor",
      payload: {
        playerId: player.id,
        ...position,
        sequence: Math.max(0, Math.floor(Number(message.payload.sequence) || 0)),
        clientSentAt: Number(message.payload.clientSentAt) || 0,
        serverSentAt: now,
      },
    };
    this.sendToHosts(cursorMessage);

    const players = this.mergePlayers(state);
    const itPlayer = players.find((candidate) => candidate.id === state.itPlayerId);
    if (!itPlayer?.connected) return;

    const movingPlayer = players.find((candidate) => candidate.id === player.id) ?? player;
    const tagTarget =
      movingPlayer.id === itPlayer.id
        ? players.find(
            (candidate) =>
              candidate.id !== itPlayer.id &&
              candidate.connected &&
              this.collides(position, candidate.position, state.aspectRatio),
          )
        : this.collides(position, itPlayer.position, state.aspectRatio)
          ? movingPlayer
          : undefined;

    if (!tagTarget || tagTarget.id === itPlayer.id) return;
    await this.handleTag(state, players, itPlayer, tagTarget);
  }

  private async handleTag(
    state: StoredRoom,
    players: RoomPlayer[],
    itPlayer: RoomPlayer,
    taggedPlayer: RoomPlayer,
  ) {
    const now = Date.now();
    const duration = randomRoundDurationMs();
    state.players = players.map((player) =>
      player.id === itPlayer.id ? { ...player, score: player.score + 1 } : player,
    );
    state.itPlayerId = taggedPlayer.id;
    state.round += 1;
    state.roundDurationMs = duration;
    state.roundEndsAt = now + duration;
    state.freezeUntil = now + GAME_CONFIG.freezeMs;
    state.frozenPlayerIds = [itPlayer.id, taggedPlayer.id];
    state.impact = {
      id: crypto.randomUUID(),
      x: (itPlayer.position.x + taggedPlayer.position.x) / 2,
      y: (itPlayer.position.y + taggedPlayer.position.y) / 2,
      at: now,
      fromPlayerId: itPlayer.id,
      toPlayerId: taggedPlayer.id,
    };
    this.saveState(state);
    await this.ctx.storage.setAlarm(state.roundEndsAt);
    this.sendToAll({ type: "tag", payload: this.snapshot(state) });
  }

  private async handleTimeout(state: StoredRoom) {
    const timedOutPlayerId = state.itPlayerId;
    const players = this.mergePlayers(state).map((player) =>
      player.id === timedOutPlayerId ? { ...player, score: player.score - 1 } : player,
    );
    state.players = players;
    state.round += 1;
    state.freezeUntil = null;
    state.frozenPlayerIds = [];
    state.impact = null;

    const eligible = players.filter((player) => player.connected && player.calibrated);
    if (eligible.length < GAME_CONFIG.minPlayers) {
      state.itPlayerId = null;
      state.roundEndsAt = null;
      state.roundDurationMs = null;
      await this.ctx.storage.deleteAlarm();
    } else {
      const alternatives = eligible.filter((player) => player.id !== timedOutPlayerId);
      const pool = alternatives.length ? alternatives : eligible;
      const duration = randomRoundDurationMs();
      state.itPlayerId = pool[randomIndex(pool.length)].id;
      state.roundDurationMs = duration;
      state.roundEndsAt = Date.now() + duration;
      await this.ctx.storage.setAlarm(state.roundEndsAt);
    }

    this.saveState(state);
    this.sendToAll({
      type: "timeout",
      payload: { timedOutPlayerId: timedOutPlayerId ?? "", snapshot: this.snapshot(state) },
    });
  }

  private assignReplacementIt(state: StoredRoom, excludedId?: string) {
    const eligible = this.mergePlayers(state).filter(
      (player) => player.connected && player.calibrated && player.id !== excludedId,
    );
    if (eligible.length < GAME_CONFIG.minPlayers) {
      state.itPlayerId = null;
      state.roundEndsAt = null;
      state.roundDurationMs = null;
      return;
    }
    const duration = randomRoundDurationMs();
    state.itPlayerId = eligible[randomIndex(eligible.length)].id;
    state.round += 1;
    state.roundDurationMs = duration;
    state.roundEndsAt = Date.now() + duration;
    state.freezeUntil = null;
    state.frozenPlayerIds = [];
  }

  private collides(a: CursorPosition, b: CursorPosition, aspectRatio: number) {
    const dx = (a.x - b.x) * aspectRatio;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy) <= GAME_CONFIG.collisionRadius;
  }

  private maxPlayers() {
    const configured = Number(this.env.MAX_PLAYERS);
    return Number.isInteger(configured) && configured >= 2 && configured <= 16
      ? configured
      : GAME_CONFIG.maxPlayers;
  }

  private loadState(): StoredRoom {
    const row = this.ctx.storage.sql
      .exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1")
      .toArray()[0];
    if (!row) return { ...defaultRoom(), maxPlayers: this.maxPlayers() };
    try {
      return { ...defaultRoom(), ...JSON.parse(row.json), maxPlayers: this.maxPlayers() };
    } catch {
      return { ...defaultRoom(), maxPlayers: this.maxPlayers() };
    }
  }

  private saveState(state: StoredRoom) {
    this.ctx.storage.sql.exec(
      `INSERT INTO room_state (id, json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      JSON.stringify(state),
      Date.now(),
    );
  }

  private mergePlayers(state: StoredRoom) {
    const players = new Map(
      state.players.map((player) => [player.id, { ...player, connected: false }]),
    );
    for (const socket of this.ctx.getWebSockets("player")) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.player) {
        const stored = players.get(attachment.player.id);
        players.set(attachment.player.id, {
          ...stored,
          ...attachment.player,
          score: stored?.score ?? attachment.player.score,
          connected: true,
        });
      }
    }
    return [...players.values()];
  }

  private snapshot(state: StoredRoom): RoomSnapshot {
    return {
      ...state,
      hostConnected: this.ctx
        .getWebSockets("host")
        .some((socket) => socket.readyState === WebSocket.OPEN),
      players: this.mergePlayers(state),
    };
  }

  private broadcastSnapshot(state: StoredRoom) {
    this.sendToAll({ type: "snapshot", payload: this.snapshot(state) });
  }

  private sendToHosts(message: ServerRoomMessage) {
    for (const socket of this.ctx.getWebSockets("host")) this.send(socket, message);
  }

  private sendToAll(message: ServerRoomMessage) {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  private send(socket: WebSocket, message: ServerRoomMessage) {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A close event will reconcile stale presence.
    }
  }
}

function isOriginAllowed(request: Request, configuredOrigins?: string) {
  if (!configuredOrigins?.trim()) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return configuredOrigins
    .split(",")
    .map((allowed) => allowed.trim())
    .filter(Boolean)
    .includes(origin);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "cursor-tag-realtime" });
    }

    const match = url.pathname.match(/^\/rooms\/([^/]+)$/);
    const roomCode = match?.[1]?.toUpperCase();
    if (!roomCode || !ROOM_CODE_PATTERN.test(roomCode)) {
      return jsonResponse({ error: "Invalid room code" }, 404);
    }

    const allowedOrigins = (env as Cloudflare.Env & { ALLOWED_ORIGINS?: string })
      .ALLOWED_ORIGINS;
    if (!isOriginAllowed(request, allowedOrigins)) {
      return jsonResponse({ error: "Origin not allowed" }, 403);
    }

    const room = env.ROOMS.getByName(roomCode);
    return room.fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
