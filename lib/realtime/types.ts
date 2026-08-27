export type RoomPhase = "lobby" | "playing" | "finished";

export type CursorPosition = {
  x: number;
  y: number;
};

export type PowerUpType = "shield" | "freeze" | "bonus";

export type ArenaPowerUp = CursorPosition & {
  id: string;
  type: PowerUpType;
};

export type PowerUpEvent = {
  id: string;
  type: PowerUpType;
  playerId: string;
  at: number;
};

export type RoomPlayer = {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  calibrated: boolean;
  position: CursorPosition;
  score: number;
  lives: number;
  eliminated: boolean;
  shieldUntil: number | null;
};

export type Impact = {
  id: string;
  x: number;
  y: number;
  at: number;
  fromPlayerId: string;
  toPlayerId: string;
};

export type RoomSnapshot = {
  phase: RoomPhase;
  hostConnected: boolean;
  players: RoomPlayer[];
  itPlayerId: string | null;
  round: number;
  roundEndsAt: number | null;
  roundDurationMs: number | null;
  freezeUntil: number | null;
  frozenPlayerIds: string[];
  protectedPlayerId: string | null;
  invulnerableUntil: number | null;
  impact: Impact | null;
  powerUps: ArenaPowerUp[];
  powerUpEvent: PowerUpEvent | null;
  maxPlayers: number;
  maxLives: number;
  maxRounds: number;
  collisionRadius: number;
};

export type ClientRoomMessage =
  | { type: "join"; payload: { name: string; hue?: number; calibrated?: boolean } }
  | { type: "calibrated" }
  | {
      type: "cursor";
      payload: CursorPosition & { sequence: number; clientSentAt: number };
    }
  | { type: "host-start"; payload: { aspectRatio: number } }
  | { type: "host-viewport"; payload: { aspectRatio: number } }
  | { type: "host-end" }
  | { type: "host-reset" }
  | { type: "request-snapshot" }
  | { type: "ping"; payload: { id: string; clientSentAt: number } };

export type ServerRoomMessage =
  | { type: "connected"; payload: { clientId: string; snapshot: RoomSnapshot } }
  | { type: "snapshot"; payload: RoomSnapshot }
  | {
      type: "cursor";
      payload: CursorPosition & {
        playerId: string;
        sequence: number;
        clientSentAt: number;
        serverSentAt: number;
      };
    }
  | { type: "tag"; payload: RoomSnapshot }
  | {
      type: "timeout";
      payload: { timedOutPlayerId: string; snapshot: RoomSnapshot };
    }
  | {
      type: "pong";
      payload: { id: string; clientSentAt: number; serverSentAt: number };
    }
  | { type: "room-closed" }
  | { type: "error"; message: string };
