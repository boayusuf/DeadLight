import { BARREL_LENGTH, HIT_RADIUS } from './constants.js';
import { traceBeam, type Segment, type World } from './maps.js';

export interface Shooter {
  id: string;
  x: number;
  y: number;
  aim: number;
}

/** A fired beam: one straight segment, plus one more for each mirror it bounced off. */
export interface Beam {
  id: string;
  segments: Segment[];
}

export interface Kill {
  shooter: string;
  target: string;
}

/** A pair whose beams found each other. Both survive the round. */
export interface Duel {
  a: string;
  b: string;
}

export interface Resolution {
  beams: Beam[];
  kills: Kill[];
  duels: Duel[];
  eliminated: string[];
  /** Crates destroyed this round. */
  broken: string[];
}

function beamOrigin(s: Shooter) {
  return { x: s.x + Math.cos(s.aim) * BARREL_LENGTH, y: s.y + Math.sin(s.aim) * BARREL_LENGTH };
}

/** Closest-approach test between a bounded ray and a circle. */
function raySegmentHitsCircle(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  length: number,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  const t = Math.min(Math.max((cx - ox) * dx + (cy - oy) * dy, 0), length);
  const px = ox + dx * t - cx;
  const py = oy + dy * t - cy;
  return px * px + py * py <= radius * radius;
}

/**
 * Resolves one round against a single snapshot.
 *
 * Beams pierce: every player a beam crosses is hit. Hits are then cancelled
 * pairwise — if two players hit each other, that pair neutralises and both
 * survive, but either beam still kills anyone else it crossed. A beam that
 * comes back off a mirror can hit its own shooter.
 */
export function resolveRound(shooters: readonly Shooter[], world: World): Resolution {
  const beams: Beam[] = [];
  const hit = new Map<string, Set<string>>();
  const broken = new Set<string>();

  for (const s of shooters) {
    const dir = { x: Math.cos(s.aim), y: Math.sin(s.aim) };
    const path = traceBeam(beamOrigin(s), dir, world);
    beams.push({ id: s.id, segments: path.segments });
    for (const id of path.struck) broken.add(id);

    const struck = new Set<string>();
    path.segments.forEach((seg, i) => {
      const dx = seg.ex - seg.ox;
      const dy = seg.ey - seg.oy;
      const length = Math.hypot(dx, dy);
      if (length === 0) return;
      for (const target of shooters) {
        if (target.id === s.id && i === 0) continue;
        if (raySegmentHitsCircle(seg.ox, seg.oy, dx / length, dy / length, length, target.x, target.y, HIT_RADIUS)) {
          struck.add(target.id);
        }
      }
    });
    hit.set(s.id, struck);
  }

  const duels: Duel[] = [];
  for (let i = 0; i < shooters.length; i++) {
    for (let j = i + 1; j < shooters.length; j++) {
      const a = shooters[i]!.id;
      const b = shooters[j]!.id;
      if (hit.get(a)?.has(b) && hit.get(b)?.has(a)) {
        hit.get(a)!.delete(b);
        hit.get(b)!.delete(a);
        duels.push({ a, b });
      }
    }
  }

  const kills: Kill[] = [];
  const eliminated = new Set<string>();
  for (const s of shooters) {
    for (const target of hit.get(s.id)!) {
      kills.push({ shooter: s.id, target });
      eliminated.add(target);
    }
  }

  return { beams, kills, duels, eliminated: [...eliminated], broken: [...broken] };
}
