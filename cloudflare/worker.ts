import { DurableObject } from "cloudflare:workers";

import {
  GAME_CONFIG,
  PLAYER_COLORS,
  playerColorFromHue,
} from "../lib/game/config";
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
  hostDisconnectExpiresAt: number | null;
  playerDisconnectExpiresAt: Record<string, number>;
  closed: boolean;
};

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
const MAX_MESSAGE_BYTES = 2_048;
const HOST_RECONNECT_GRACE_MS = 5_000;
const PLAYER_RECONNECT_GRACE_MS = 10_000;

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

function randomRoundDurationMs(round: number, previousDurationMs?: number | null) {
  const completedRounds = Math.max(0, round - 1);
  const minimum = Math.max(
    GAME_CONFIG.fastestMinRoundSeconds,
    GAME_CONFIG.minRoundSeconds -
      completedRounds * GAME_CONFIG.minRoundDecayPerRound,
  );
  const maximum = Math.max(
    GAME_CONFIG.fastestMaxRoundSeconds,
    GAME_CONFIG.maxRoundSeconds -
      completedRounds * GAME_CONFIG.maxRoundDecayPerRound,
  );
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  const random = bytes[0] / 2 ** 32;
  const randomizedDuration = Math.round(
    (minimum + random * (maximum - minimum)) * 1_000,
  );
  if (!previousDurationMs) return randomizedDuration;
  return Math.max(
    GAME_CONFIG.fastestMinRoundSeconds * 1_000,
    Math.min(
      randomizedDuration,
      previousDurationMs - GAME_CONFIG.minimumRoundDecreaseMs,
    ),
  );
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
    protectedPlayerId: null,
    invulnerableUntil: null,
    impact: null,
    maxPlayers: GAME_CONFIG.maxPlayers,
    maxLives: GAME_CONFIG.startingLives,
    maxRounds: GAME_CONFIG.maxRounds,
    collisionRadius: GAME_CONFIG.collisionRadius,
    aspectRatio: 16 / 9,
    hostDisconnectExpiresAt: null,
    playerDisconnectExpiresAt: {},
    closed: false,
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
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      const state = this.loadState();
      const hostConnected = this.ctx
        .getWebSockets("host")
        .some((socket) => socket.readyState === WebSocket.OPEN);
      return jsonResponse({ exists: !state.closed && hostConnected });
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Expected a WebSocket upgrade" }, 426);
    }

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

    let state = this.loadState();
    if (role === "host") {
      if (state.closed) {
        state = { ...defaultRoom(), maxPlayers: this.maxPlayers() };
      }
      state.hostDisconnectExpiresAt = null;
      this.saveState(state);
      await this.scheduleNextAlarm(state);
    } else if (
      state.closed ||
      !this.ctx
        .getWebSockets("host")
        .some((socket) => socket.readyState === WebSocket.OPEN)
    ) {
      this.send(server, { type: "room-closed" });
      server.close(4004, state.closed ? "Room closed" : "Host not connected");
      return new Response(null, { status: 101, webSocket: client });
    }
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

    if (attachment?.role === "host") {
      const hostStillConnected = this.ctx
        .getWebSockets("host")
        .some((candidate) => candidate.readyState === WebSocket.OPEN);
      if (!hostStillConnected && !state.closed) {
        state.hostDisconnectExpiresAt = Date.now() + HOST_RECONNECT_GRACE_MS;
        this.saveState(state);
        await this.scheduleNextAlarm(state);
      }
      this.broadcastSnapshot(state);
      return;
    }

    if (state.closed) return;

    if (attachment?.role === "player" && attachment.player) {
      const replacementConnected = this.ctx
        .getWebSockets("player")
        .some((candidate) => {
          if (candidate.readyState !== WebSocket.OPEN) return false;
          const candidateAttachment = candidate.deserializeAttachment() as SocketAttachment | null;
          return (
            candidateAttachment?.clientId === attachment.clientId &&
            Boolean(candidateAttachment.player)
          );
        });
      if (replacementConnected) return;

      const storedPlayer = state.players.find(
        (player) => player.id === attachment.player?.id,
      );
      const disconnected = {
        ...attachment.player,
        score: storedPlayer?.score ?? attachment.player.score,
        lives: storedPlayer?.lives ?? attachment.player.lives,
        eliminated: storedPlayer?.eliminated ?? attachment.player.eliminated,
        connected: false,
      };
      state.players = this.mergePlayers(state).map((player) =>
        player.id === disconnected.id ? disconnected : player,
      );
      state.playerDisconnectExpiresAt[disconnected.id] =
        Date.now() + PLAYER_RECONNECT_GRACE_MS;

      if (state.phase === "playing" && state.itPlayerId === disconnected.id) {
        this.assignReplacementIt(state, disconnected.id);
      }

      this.saveState(state);
      await this.scheduleNextAlarm(state);
    }

    this.broadcastSnapshot(state);
  }

  webSocketError(socket: WebSocket) {
    socket.close(1011, "Socket error");
  }

  async alarm() {
    const state = this.loadState();
    const now = Date.now();
    const hostConnected = this.ctx
      .getWebSockets("host")
      .some((socket) => socket.readyState === WebSocket.OPEN);

    if (
      state.hostDisconnectExpiresAt &&
      now + 25 >= state.hostDisconnectExpiresAt &&
      !hostConnected
    ) {
      await this.closeRoom(state);
      return;
    }
    if (hostConnected && state.hostDisconnectExpiresAt) {
      state.hostDisconnectExpiresAt = null;
      this.saveState(state);
    }
    const players = this.mergePlayers(state);
    const expiredPlayerIds = Object.entries(state.playerDisconnectExpiresAt)
      .filter(([, expiresAt]) => now + 25 >= expiresAt)
      .map(([playerId]) => playerId);
    if (expiredPlayerIds.length) {
      const expired = new Set(expiredPlayerIds);
      const connectedIds = new Set(
        players.filter((player) => player.connected).map((player) => player.id),
      );
      state.players = players.filter(
        (player) => !expired.has(player.id) || connectedIds.has(player.id),
      );
      for (const playerId of expiredPlayerIds) {
        delete state.playerDisconnectExpiresAt[playerId];
      }
      this.saveState(state);
      this.broadcastSnapshot(state);
    }
    if (
      state.phase === "playing" &&
      state.roundEndsAt &&
      now + 25 >= state.roundEndsAt
    ) {
      await this.handleTimeout(state);
      return;
    }
    await this.scheduleNextAlarm(state);
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
        (player) => player.connected && player.calibrated && !player.eliminated,
      );
      if (eligible.length < GAME_CONFIG.minPlayers) {
        this.sendToHosts({
          type: "error",
          message: `At least ${GAME_CONFIG.minPlayers} calibrated players are required`,
        });
        return;
      }

      const duration = randomRoundDurationMs(1);
      const now = Date.now();
      state.phase = "playing";
      state.players = this.mergePlayers(state).map((player) => ({
        ...player,
        score: 0,
        lives: GAME_CONFIG.startingLives,
        eliminated: false,
      }));
      state.itPlayerId = eligible[randomIndex(eligible.length)].id;
      state.round = 1;
      state.roundDurationMs = duration;
      state.roundEndsAt = now + duration;
      state.freezeUntil = null;
      state.frozenPlayerIds = [];
      state.protectedPlayerId = state.itPlayerId;
      state.invulnerableUntil = now + GAME_CONFIG.tagImmunityMs;
      state.impact = null;
      state.aspectRatio = Math.max(
        0.5,
        Math.min(3, Number(message.payload.aspectRatio) || 16 / 9),
      );
      this.saveState(state);
      await this.scheduleNextAlarm(state);
      this.broadcastSnapshot(state);
      return;
    }

    if (message.type === "host-end") {
      state.phase = "finished";
      state.roundEndsAt = null;
      state.roundDurationMs = null;
      state.freezeUntil = null;
      state.frozenPlayerIds = [];
      state.protectedPlayerId = null;
      state.invulnerableUntil = null;
      this.saveState(state);
      await this.scheduleNextAlarm(state);
      this.broadcastSnapshot(state);
      return;
    }

    if (message.type === "host-reset") {
      const next = defaultRoom();
      next.players = this.mergePlayers(state).map((player) => ({
        ...player,
        score: 0,
        lives: GAME_CONFIG.startingLives,
        eliminated: false,
      }));
      next.playerDisconnectExpiresAt = { ...state.playerDisconnectExpiresAt };
      next.aspectRatio = state.aspectRatio;
      this.saveState(next);
      await this.scheduleNextAlarm(next);
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
      const requestedColor = Number.isFinite(message.payload.hue)
        ? playerColorFromHue(message.payload.hue as number)
        : null;
      const color =
        requestedColor ??
        existing?.color ??
        PLAYER_COLORS.find((candidate) => !usedColors.has(candidate)) ??
        PLAYER_COLORS[currentPlayers.length % PLAYER_COLORS.length];
      const player: RoomPlayer = {
        id: attachment.clientId,
        name: cleanName,
        color,
        connected: true,
        calibrated: message.payload.calibrated ?? existing?.calibrated ?? false,
        position: existing?.position ?? {
          x: 0.3 + (currentPlayers.length % 4) * 0.13,
          y: 0.4 + Math.floor(currentPlayers.length / 4) * 0.2,
        },
        score: existing?.score ?? 0,
        lives: existing?.lives ?? GAME_CONFIG.startingLives,
        eliminated: existing?.eliminated ?? false,
      };
      delete state.playerDisconnectExpiresAt[player.id];
      socket.serializeAttachment({ ...attachment, player });
      state.players = currentPlayers.some((candidate) => candidate.id === player.id)
        ? currentPlayers.map((candidate) => (candidate.id === player.id ? player : candidate))
        : [...currentPlayers, player];

      if (state.phase === "playing" && !state.itPlayerId) {
        this.assignReplacementIt(state);
      }
      this.saveState(state);
      await this.scheduleNextAlarm(state);
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
      await this.scheduleNextAlarm(state);
      this.broadcastSnapshot(state);
      return;
    }

    if (message.type !== "cursor") return;
    const now = Date.now();
    if (state.phase !== "playing") return;
    if (attachment.player.eliminated) return;

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
    if (!itPlayer?.connected || itPlayer.eliminated) return;
    if (
      state.protectedPlayerId === itPlayer.id &&
      state.invulnerableUntil &&
      now < state.invulnerableUntil
    ) {
      return;
    }

    const movingPlayer = players.find((candidate) => candidate.id === player.id) ?? player;
    const tagTarget =
      movingPlayer.id === itPlayer.id
        ? players.find(
            (candidate) =>
              candidate.id !== itPlayer.id &&
              candidate.connected &&
              !candidate.eliminated &&
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
    state.players = players.map((player) =>
      player.id === itPlayer.id ? { ...player, score: player.score + 1 } : player,
    );
    if (state.round >= GAME_CONFIG.maxRounds) {
      this.finishGame(state);
      this.saveState(state);
      await this.scheduleNextAlarm(state);
      this.sendToAll({ type: "tag", payload: this.snapshot(state) });
      return;
    }

    state.round += 1;
    const duration = randomRoundDurationMs(
      state.round,
      state.roundDurationMs,
    );
    state.itPlayerId = taggedPlayer.id;
    state.roundDurationMs = duration;
    state.roundEndsAt = now + duration;
    state.freezeUntil = now + GAME_CONFIG.freezeMs;
    state.frozenPlayerIds = [itPlayer.id, taggedPlayer.id];
    state.protectedPlayerId = taggedPlayer.id;
    state.invulnerableUntil = now + GAME_CONFIG.tagImmunityMs;
    state.impact = {
      id: crypto.randomUUID(),
      x: (itPlayer.position.x + taggedPlayer.position.x) / 2,
      y: (itPlayer.position.y + taggedPlayer.position.y) / 2,
      at: now,
      fromPlayerId: itPlayer.id,
      toPlayerId: taggedPlayer.id,
    };
    this.saveState(state);
    await this.scheduleNextAlarm(state);
    this.sendToAll({ type: "tag", payload: this.snapshot(state) });
  }

  private async handleTimeout(state: StoredRoom) {
    const timedOutPlayerId = state.itPlayerId;
    const players = this.mergePlayers(state).map((player) =>
      player.id === timedOutPlayerId
        ? {
            ...player,
            score: player.score - 1,
            lives: Math.max(0, player.lives - 1),
            eliminated: player.lives <= 1,
          }
        : player,
    );
    state.players = players;
    state.freezeUntil = null;
    state.frozenPlayerIds = [];
    state.protectedPlayerId = null;
    state.invulnerableUntil = null;
    state.impact = null;

    const survivors = players.filter((player) => !player.eliminated);
    if (survivors.length <= 1 || state.round >= GAME_CONFIG.maxRounds) {
      this.finishGame(state);
      this.saveState(state);
      await this.scheduleNextAlarm(state);
      this.sendToAll({
        type: "timeout",
        payload: {
          timedOutPlayerId: timedOutPlayerId ?? "",
          snapshot: this.snapshot(state),
        },
      });
      return;
    }

    state.round += 1;
    const eligible = players.filter(
      (player) => player.connected && player.calibrated && !player.eliminated,
    );
    if (eligible.length < GAME_CONFIG.minPlayers) {
      state.itPlayerId = null;
      state.roundEndsAt = null;
      state.roundDurationMs = null;
    } else {
      const alternatives = eligible.filter((player) => player.id !== timedOutPlayerId);
      const pool = alternatives.length ? alternatives : eligible;
      const duration = randomRoundDurationMs(
        state.round,
        state.roundDurationMs,
      );
      const now = Date.now();
      state.itPlayerId = pool[randomIndex(pool.length)].id;
      state.roundDurationMs = duration;
      state.roundEndsAt = now + duration;
      state.protectedPlayerId = state.itPlayerId;
      state.invulnerableUntil = now + GAME_CONFIG.tagImmunityMs;
    }

    this.saveState(state);
    await this.scheduleNextAlarm(state);
    this.sendToAll({
      type: "timeout",
      payload: { timedOutPlayerId: timedOutPlayerId ?? "", snapshot: this.snapshot(state) },
    });
  }

  private assignReplacementIt(state: StoredRoom, excludedId?: string) {
    const active = this.mergePlayers(state).filter(
      (player) => player.connected && player.calibrated && !player.eliminated,
    );
    if (active.length < GAME_CONFIG.minPlayers) {
      state.itPlayerId = null;
      state.roundEndsAt = null;
      state.roundDurationMs = null;
      return;
    }
    state.round += 1;
    if (state.round > GAME_CONFIG.maxRounds) {
      this.finishGame(state);
      return;
    }
    const candidates = active.filter((player) => player.id !== excludedId);
    const pool = candidates.length ? candidates : active;
    const duration = randomRoundDurationMs(
      state.round,
      state.roundDurationMs,
    );
    const now = Date.now();
    state.itPlayerId = pool[randomIndex(pool.length)].id;
    state.roundDurationMs = duration;
    state.roundEndsAt = now + duration;
    state.freezeUntil = null;
    state.frozenPlayerIds = [];
    state.protectedPlayerId = state.itPlayerId;
    state.invulnerableUntil = now + GAME_CONFIG.tagImmunityMs;
  }

  private finishGame(state: StoredRoom) {
    state.phase = "finished";
    state.itPlayerId = null;
    state.roundEndsAt = null;
    state.roundDurationMs = null;
    state.freezeUntil = null;
    state.frozenPlayerIds = [];
    state.protectedPlayerId = null;
    state.invulnerableUntil = null;
  }

  private async closeRoom(state: StoredRoom) {
    const closedState = {
      ...defaultRoom(),
      maxPlayers: this.maxPlayers(),
      aspectRatio: state.aspectRatio,
      closed: true,
    };
    this.saveState(closedState);
    await this.ctx.storage.deleteAlarm();
    this.sendToAll({ type: "room-closed" });
    for (const socket of this.ctx.getWebSockets("player")) {
      socket.close(4004, "Host left the room");
    }
  }

  private async scheduleNextAlarm(state: StoredRoom) {
    const deadlines = [
      state.hostDisconnectExpiresAt,
      state.phase === "playing" ? state.roundEndsAt : null,
      ...Object.values(state.playerDisconnectExpiresAt),
    ].filter((deadline): deadline is number => typeof deadline === "number");
    if (!deadlines.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...deadlines));
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
      const parsed = JSON.parse(row.json) as Partial<StoredRoom>;
      const restored: StoredRoom = {
        ...defaultRoom(),
        ...parsed,
        players: (parsed.players ?? []).map((player) => ({
          ...player,
          lives:
            typeof player.lives === "number"
              ? player.lives
              : GAME_CONFIG.startingLives,
          eliminated:
            typeof player.eliminated === "boolean"
              ? player.eliminated
              : false,
        })),
        playerDisconnectExpiresAt:
          parsed.playerDisconnectExpiresAt &&
          typeof parsed.playerDisconnectExpiresAt === "object"
            ? parsed.playerDisconnectExpiresAt
            : {},
        maxPlayers: this.maxPlayers(),
        maxLives: GAME_CONFIG.startingLives,
        maxRounds: GAME_CONFIG.maxRounds,
      };
      if (
        restored.phase === "playing" &&
        restored.round > GAME_CONFIG.maxRounds
      ) {
        this.finishGame(restored);
      }
      return restored;
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
          lives: stored?.lives ?? attachment.player.lives,
          eliminated: stored?.eliminated ?? attachment.player.eliminated,
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

function withCors(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", request.headers.get("origin") ?? "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const isStatusRequest = url.pathname.endsWith("/status");
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "cursor-tag-realtime" });
    }

    const match = url.pathname.match(/^\/rooms\/([^/]+)(?:\/status)?$/);
    const roomCode = match?.[1]?.toUpperCase();
    if (!roomCode || !ROOM_CODE_PATTERN.test(roomCode)) {
      return jsonResponse({ error: "Invalid room code" }, 404);
    }

    const allowedOrigins = (env as Cloudflare.Env & { ALLOWED_ORIGINS?: string })
      .ALLOWED_ORIGINS;
    if (!isOriginAllowed(request, allowedOrigins)) {
      return jsonResponse({ error: "Origin not allowed" }, 403);
    }

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }

    const room = env.ROOMS.getByName(roomCode);
    const response = await room.fetch(request);
    return isStatusRequest ? withCors(response, request) : response;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
