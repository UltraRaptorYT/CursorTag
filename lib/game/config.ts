export const GAME_CONFIG = {
  maxPlayers: 8,
  minPlayers: 2,
  collisionRadius: 0.058,
  freezeMs: 300,
  tagImmunityMs: 1_500,
  startingLives: 3,
  maxRounds: 10,
  minRoundSeconds: 10,
  maxRoundSeconds: 20,
  fastestMinRoundSeconds: 7,
  fastestMaxRoundSeconds: 12,
  minRoundDecayPerRound: 0.75,
  maxRoundDecayPerRound: 1.5,
  minimumRoundDecreaseMs: 500,
} as const;

export const POWER_UP_CONFIG = {
  onField: 2,
  pickupRadius: 0.045,
  shieldMs: 4_000,
  freezeMs: 1_000,
  bonusPoints: 2,
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
