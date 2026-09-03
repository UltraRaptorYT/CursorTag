export const GAME_CONFIG = {
  maxPlayers: 16,
  minPlayers: 2,
  collisionRadius: 0.058,
  freezeMs: 300,
  tagImmunityMs: 1_500,
  defaultRounds: 10,
  roundOptions: [5, 10, 15],
  defaultRoundSeconds: 15,
  roundSecondsOptions: [10, 15, 20],
} as const;

// Kept only for backwards compatibility with older saved room snapshots.
export const LEGACY_STARTING_LIVES = 3;

export const POWER_UP_CONFIG = {
  pickupRadius: 0.045,
  shieldMs: 4_000,
  boostMs: 5_000,
  boostMultiplier: 1.8,
  boostSmoothing: 0.92,
  slowMs: 5_000,
  slowMultiplier: 0.4,
  slowSmoothing: 0.1,
  freezeMs: 1_000,
  bonusPoints: 2,
  modes: {
    normal: { minSpawnDelayMs: 3_000, maxSpawnDelayMs: 6_000, maxOnField: 3 },
    chaos: { minSpawnDelayMs: 1_500, maxSpawnDelayMs: 3_000, maxOnField: 5 },
  },
} as const;

export const PLAYER_COLORS = [
  "#ff5c5c",
  "#7c5cff",
  "#2dd4a8",
  "#ffbe3d",
  "#44a7ff",
  "#ff6fbd",
  "#b6f24a",
  "#ff8f4a",
] as const;

export const DEFAULT_PLAYER_HUE = 255;

export function normalizePlayerHue(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_PLAYER_HUE;
  return ((Math.round(value) % 360) + 360) % 360;
}

export function playerColorFromHue(hue: number) {
  return `hsl(${normalizePlayerHue(hue)} 84% 62%)`;
}

export function sanitizeRoomCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export function generateRoomCode(length = 6) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
