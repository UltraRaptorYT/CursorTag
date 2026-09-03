export const GAME_CONFIG = {
  maxPlayers: 16,
  minPlayers: 2,
  collisionRadius: 0.058,
  freezeMs: 600,
  tagImmunityMs: 2_000,
  defaultRounds: 20,
  roundOptions: [10, 15, 20, 30],
  defaultRoundSeconds: 20,
  roundSecondsOptions: [15, 20, 30],
} as const;

// Kept only for backwards compatibility with older saved room snapshots.
export const LEGACY_STARTING_LIVES = 3;

export const POWER_UP_CONFIG = {
  pickupRadius: 0.045,
  shieldMs: 4_000,
  boostMs: 5_000,
  boostMultiplier: 1.8,
  boostSmoothing: 0.5,
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

// Sixteen evenly spaced slots keep every cursor visually distinct at room capacity.
export const PLAYER_HUES = [
  0, 23, 45, 68, 90, 113, 135, 158,
  180, 203, 225, 248, 270, 293, 315, 338,
] as const;

export const DEFAULT_PLAYER_HUE = 255;

export function normalizePlayerHue(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_PLAYER_HUE;
  return ((Math.round(value) % 360) + 360) % 360;
}

export function playerColorFromHue(hue: number) {
  return `hsl(${normalizePlayerHue(hue)} 84% 62%)`;
}

export function playerHueFromColor(color: string) {
  const generatedMatch = color.match(/^hsl\((\d+(?:\.\d+)?)\s/);
  if (generatedMatch) return normalizePlayerHue(Number(generatedMatch[1]));

  const legacyIndex = PLAYER_COLORS.indexOf(
    color as (typeof PLAYER_COLORS)[number],
  );
  return legacyIndex >= 0 ? PLAYER_HUES[legacyIndex] : null;
}

function hueDistance(first: number, second: number) {
  const distance = Math.abs(normalizePlayerHue(first) - normalizePlayerHue(second));
  return Math.min(distance, 360 - distance);
}

export function nearestPlayerHueSlot(hue: number) {
  const requested = normalizePlayerHue(hue);
  return [...PLAYER_HUES].sort(
    (first, second) =>
      hueDistance(first, requested) - hueDistance(second, requested),
  )[0];
}

export function nearestAvailablePlayerHue(
  requestedHue: number,
  unavailableHues: ReadonlySet<number>,
) {
  const requested = normalizePlayerHue(requestedHue);
  return (
    [...PLAYER_HUES]
      .filter((hue) => !unavailableHues.has(hue))
      .sort((first, second) =>
        hueDistance(first, requested) - hueDistance(second, requested),
      )[0] ?? PLAYER_HUES[0]
  );
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
