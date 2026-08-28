import type { ClientRoomMessage, ServerRoomMessage } from "../lib/realtime/types";

const endpoint = process.env.REALTIME_SMOKE_URL ?? "ws://localhost:8787";
const roomCode = `SMK${Date.now().toString(36).slice(-5).toUpperCase()}`;

class TestClient {
  socket: WebSocket;
  messages: ServerRoomMessage[] = [];

  constructor(role: "host" | "player", clientId: string) {
    this.socket = new WebSocket(
      `${endpoint}/rooms/${roomCode}?role=${role}&clientId=${clientId}`,
    );
    this.socket.addEventListener("message", (event) => {
      this.messages.push(JSON.parse(String(event.data)) as ServerRoomMessage);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket open timed out")), 5_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Socket failed")), { once: true });
    });
  }

  send(message: ClientRoomMessage) {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: ServerRoomMessage) => boolean,
    timeoutMs = 5_000,
    description = "real-time message",
  ) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const match = this.messages.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Expected ${description} did not arrive. Received: ${this.messages
        .slice(-8)
        .map((message) => message.type)
        .join(", ")}`,
    );
  }
}

const host = new TestClient("host", "smoke-host");
let playerOne: TestClient | undefined;
let playerTwo: TestClient | undefined;
let reconnectedPlayer: TestClient | null = null;

try {
  await host.open();
  playerOne = new TestClient("player", "smoke-player-1");
  playerTwo = new TestClient("player", "smoke-player-2");
  await Promise.all([playerOne.open(), playerTwo.open()]);
  playerOne.send({ type: "join", payload: { name: "Ada" } });
  playerTwo.send({ type: "join", payload: { name: "Lin" } });
  playerOne.send({ type: "calibrated" });
  playerTwo.send({ type: "calibrated" });

  await host.waitFor(
    (message) =>
      message.type === "snapshot" &&
      message.payload.players.filter((player) => player.calibrated).length === 2,
    5_000,
    "two calibrated players",
  );
  host.send({
    type: "host-settings",
    payload: { powerUpMode: "chaos", maxRounds: 5, roundSeconds: 10 },
  });
  await host.waitFor(
    (message) =>
      message.type === "snapshot" &&
      message.payload.powerUpMode === "chaos" &&
      message.payload.maxRounds === 5 &&
      message.payload.roundSeconds === 10,
    5_000,
    "chaos room setting",
  );
  host.send({ type: "host-start", payload: { aspectRatio: 16 / 9 } });
  const started = await host.waitFor(
    (message) => message.type === "snapshot" && message.payload.phase === "playing",
    5_000,
    "playing snapshot",
  );
  if (started.type !== "snapshot" || !started.payload.itPlayerId) {
    throw new Error("Game did not assign an it player");
  }
  if (started.payload.players.some((player) => player.eliminated)) {
    throw new Error("Players should not be eliminated in the points-only game");
  }
  if (started.payload.powerUps.length !== 0) {
    throw new Error("Power-ups should spawn during play, not at round start");
  }
  await host.waitFor(
    (message) =>
      message.type === "snapshot" &&
      message.payload.phase === "playing" &&
      message.payload.powerUps.length > 0,
    4_000,
    "random in-round power-up spawn",
  );

  const itId = started.payload.itPlayerId;
  const target = started.payload.players.find((player) => player.id !== itId);
  const itClient = itId === "smoke-player-1" ? playerOne : playerTwo;
  if (!target) throw new Error("No tag target was available");
  const immunityWait = Math.max(
    0,
    (started.payload.invulnerableUntil ?? Date.now()) - Date.now() + 75,
  );
  await new Promise((resolve) => setTimeout(resolve, immunityWait));
  itClient.send({
    type: "cursor",
    payload: { ...target.position, sequence: 1, clientSentAt: performance.now() },
  });

  const tagged = await host.waitFor(
    (message) => message.type === "tag",
    5_000,
    "tag event",
  );
  if (tagged.type !== "tag" || tagged.payload.itPlayerId !== target.id) {
    throw new Error("Tag did not transfer it status");
  }
  if (tagged.payload.freezeUntil === null || tagged.payload.frozenPlayerIds.length !== 2) {
    throw new Error("Tag freeze was not applied");
  }
  if (
    tagged.payload.protectedPlayerId !== target.id ||
    tagged.payload.invulnerableUntil === null
  ) {
    throw new Error("New chaser did not receive tag immunity");
  }
  if (
    !started.payload.roundDurationMs ||
    !tagged.payload.roundDurationMs ||
    started.payload.roundDurationMs !== 10_000 ||
    tagged.payload.roundDurationMs !== 10_000
  ) {
    throw new Error("The host-selected round time was not preserved");
  }
  if (
    !tagged.payload.roundEndsAt ||
    Math.abs(
      tagged.payload.roundEndsAt - tagged.payload.roundDurationMs - Date.now(),
    ) > 1_000
  ) {
    throw new Error("The next round timer was not reset from the tag time");
  }
  const scoringPlayer = tagged.payload.players.find((player) => player.id === itId);
  if (scoringPlayer?.score !== 1) throw new Error("Tag score was not retained");

  const taggedClient = target.id === "smoke-player-1" ? playerOne : playerTwo;
  const freezeWait = Math.max(
    0,
    (tagged.payload.freezeUntil ?? Date.now()) - Date.now() + 75,
  );
  await new Promise((resolve) => setTimeout(resolve, freezeWait));
  const tagCountBeforeImmunityCheck = host.messages.filter(
    (message) => message.type === "tag",
  ).length;
  const formerIt = tagged.payload.players.find((player) => player.id === itId);
  if (!formerIt) throw new Error("Former it player was missing");
  taggedClient.send({
    type: "cursor",
    payload: {
      ...formerIt.position,
      sequence: 2,
      clientSentAt: performance.now(),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (
    host.messages.filter((message) => message.type === "tag").length !==
    tagCountBeforeImmunityCheck
  ) {
    throw new Error("Tag immunity allowed an immediate re-tag");
  }
  taggedClient.socket.close();
  const disconnected = await host.waitFor(
    (message) =>
      message.type === "snapshot" &&
      message.payload.players.some(
        (player) => player.id === target.id && !player.connected,
      ),
    5_000,
    "disconnected cursor snapshot",
  );
  if (disconnected.type !== "snapshot" || disconnected.payload.itPlayerId !== null) {
    throw new Error("Disconnected it player was not safely released");
  }

  reconnectedPlayer = new TestClient("player", target.id);
  await reconnectedPlayer.open();
  reconnectedPlayer.send({ type: "join", payload: { name: target.name } });
  const resumed = await host.waitFor(
    (message) =>
      message.type === "snapshot" &&
      message.payload.players.some(
        (player) => player.id === target.id && player.connected,
      ) &&
      message.payload.itPlayerId !== null &&
      message.payload.roundEndsAt !== null &&
      message.payload.round > tagged.payload.round,
    5_000,
    "resumed game after the it player reconnects",
  );
  if (resumed.type !== "snapshot" || resumed.payload.phase !== "playing") {
    throw new Error("Reconnecting the released it player did not resume the game");
  }

  host.socket.close();
  const roomClosed = await reconnectedPlayer.waitFor(
    (message) => message.type === "room-closed",
    8_000,
    "room closure after the host disconnects",
  );
  if (roomClosed.type !== "room-closed") {
    throw new Error("Players were not removed when the host left");
  }

  const latePlayer = new TestClient("player", "smoke-player-late");
  await latePlayer.open();
  const rejected = await latePlayer.waitFor(
    (message) => message.type === "room-closed",
    5_000,
    "hostless room rejection",
  );
  latePlayer.socket.close();
  if (rejected.type !== "room-closed") {
    throw new Error("A player connected to a room without a host");
  }

  console.log(
    JSON.stringify({
      ok: true,
      roomCode,
      players: tagged.payload.players.length,
      round: tagged.payload.round,
      tagTransferredTo: target.name,
      disconnectedCursorRetained: true,
      reconnectResumedGame: true,
      hostDepartureClosedRoom: true,
      hostlessJoinRejected: true,
    }),
  );
} finally {
  host.socket.close();
  playerOne?.socket.close();
  playerTwo?.socket.close();
  reconnectedPlayer?.socket.close();
}
