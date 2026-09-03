export type AirMouseOrientation = {
  alpha: number;
  beta: number;
};

export type AirMouseAim = {
  x: number;
  y: number;
};

type AirMouseAimOptions = {
  sensitivity?: number;
  smoothing?: number;
};

export const AIR_MOUSE_CONFIG = {
  horizontalAimRangeDegrees: 32,
  verticalAimRangeDegrees: 24,
  smoothing: 0.32,
  sendIntervalMs: 33,
  aimChangeThreshold: 0.0015,
  deadZoneDegrees: 1.1,
} as const;

function normalizeAngleDelta(current: number, previous: number) {
  let delta = current - previous;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function applyDeadZone(value: number) {
  const magnitude = Math.abs(value);
  if (magnitude <= AIR_MOUSE_CONFIG.deadZoneDegrees) return 0;
  return Math.sign(value) * (magnitude - AIR_MOUSE_CONFIG.deadZoneDegrees);
}

function clampAim(value: number) {
  return Math.max(-1, Math.min(1, value));
}

export function calculateAirMouseAim(
  current: AirMouseOrientation,
  origin: AirMouseOrientation,
  previousAim: AirMouseAim,
  options: AirMouseAimOptions = {},
): AirMouseAim {
  const sensitivity = options.sensitivity ?? 1;
  const smoothing = options.smoothing ?? AIR_MOUSE_CONFIG.smoothing;
  const horizontalDelta = applyDeadZone(
    normalizeAngleDelta(current.alpha, origin.alpha),
  );
  const verticalDelta = applyDeadZone(current.beta - origin.beta);
  const rawAim = {
    x: clampAim(
      (-horizontalDelta /
        (AIR_MOUSE_CONFIG.horizontalAimRangeDegrees -
          AIR_MOUSE_CONFIG.deadZoneDegrees)) * sensitivity,
    ),
    y: clampAim(
      (-verticalDelta /
        (AIR_MOUSE_CONFIG.verticalAimRangeDegrees -
          AIR_MOUSE_CONFIG.deadZoneDegrees)) * sensitivity,
    ),
  };

  return {
    x:
      previousAim.x +
      (rawAim.x - previousAim.x) * smoothing,
    y:
      previousAim.y +
      (rawAim.y - previousAim.y) * smoothing,
  };
}
