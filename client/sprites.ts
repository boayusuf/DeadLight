export const SPRITE_W = 14;
export const SPRITE_H = 20;
/** Rows above the legs. The leg strips are swapped per animation frame. */
const BODY_H = 15;

export type Facing = 'down' | 'side' | 'up';

/*
 * Pixel keys
 *   o outline      s skin        S skin shadow     e eye
 *   h hair         H hair light  j jacket          J jacket light
 *   k jacket dark  t trim        b boot            g gear
 *
 * Layout: row 0 is headroom for hair, rows 1-7 the head, row 8 the neck,
 * rows 9-14 the torso, rows 15-19 the legs.
 *
 * The head is six pixels of face with hair framing it from the outside, so the
 * eyes survive. Hair drawn across the face just reads as a helmet.
 */

const BODY: Record<Facing, readonly string[]> = {
  down: [
    '..............',
    '....oooooo....',
    '...osssssso...',
    '...osssssso...',
    '...osesseso...',
    '...osssssso...',
    '...osSssSso...',
    '....oooooo....',
    '.....osso.....',
    '...otJjjjto...',
    '..ojtJjjjtjo..',
    '..ojtJjkjtjo..',
    '..ojjJjkjjjo..',
    '..oojjjkjjoo..',
    '...oggggggo...',
  ],
  side: [
    '..............',
    '....oooooo....',
    '...osssssso...',
    '...osssssso...',
    '...ossseeso...',
    '...osssssso...',
    '...osSsssSo...',
    '....oooooo....',
    '.....osso.....',
    '...otJjjjto...',
    '...ojJjjjto...',
    '...ojJjkjto...',
    '...ojjjkjjo...',
    '...oojjkjoo...',
    '....oggggo....',
  ],
  up: [
    '..............',
    '....oooooo....',
    '...ohhhhhho...',
    '...ohhhhhho...',
    '...ohhhhhho...',
    '...ohhhhhho...',
    '...ohhHhhho...',
    '....oooooo....',
    '.....osso.....',
    '...otJjjjto...',
    '..ojtJjjjtjo..',
    '..ojtJjkjtjo..',
    '..ojjJjkjjjo..',
    '..oojjjkjjoo..',
    '...oggggggo...',
  ],
};

/** Two contact poses; the body bobs a pixel between them for the in-between. */
const LEGS: readonly (readonly string[])[] = [
  [
    '...ojjoojjo...',
    '...ojjoojjo...',
    '...ojjoojjo...',
    '...obboobbo...',
    '....oo..oo....',
  ],
  [
    '..ojjoooojjo..',
    '..ojjoooojjo..',
    '.ojjoooooojjo.',
    '.obboooooobbo.',
    '..oo......oo..',
  ],
];

/**
 * Hair covers the crown, then only the outer columns. Each fighter needs a
 * silhouette that survives being six pixels tall.
 */
const HAIR: readonly { front: readonly string[]; side: readonly string[] }[] = [
  // 0 — short swept spikes
  {
    front: [
      '...oh.oh.oh...',
      '..ohhhhhhhho..',
      '..ohhHhhhHho..',
      '..ohh....hho..',
      '...oh....ho...',
      '..............',
      '..............',
      '..............',
      '..............',
      '..............',
    ],
    side: [
      '..oh.oh.ohho..',
      '..ohhhhhhhho..',
      '..ohhHhhhhho..',
      '..ohhh...hho..',
      '..ohho........',
      '...oo.........',
      '..............',
      '..............',
      '..............',
      '..............',
    ],
  },
  // 1 — long, parted
  {
    front: [
      '..ohhhhhhhho..',
      '..ohhhhhhhho..',
      '..ohhHhhhHho..',
      '..ohh....hho..',
      '..ohh....hho..',
      '..ohh....hho..',
      '..ohh....hho..',
      '...oh....ho...',
      '....o....o....',
      '..............',
    ],
    side: [
      '..ohhhhhhhho..',
      '..ohhhhhhhho..',
      '..ohhHhhhhho..',
      '..ohhh...hho..',
      '..ohh.........',
      '..ohh.........',
      '..ohh.........',
      '..ohho........',
      '...oo.........',
      '..............',
    ],
  },
  // 2 — cropped, with a tail at the back
  {
    front: [
      '..ohhhhhhhho..',
      '..ohhhhhhhho..',
      '..ohhHhhhHho..',
      '..ohh....hho..',
      '...o......o...',
      '..............',
      '..............',
      '..............',
      '..............',
      '..............',
    ],
    side: [
      '..ohhhhhhhho..',
      '..ohhhhhhhho..',
      '..ohhHhhhhho..',
      '.ohhhh...hho..',
      '.ohhho........',
      '.ohhho........',
      '.ohhho........',
      '..ohho........',
      '...oo.........',
      '..............',
    ],
  },
  // 3 — heavy fringe over one eye
  {
    front: [
      '..ohhhhhhhho..',
      '..ohhhhhhhho..',
      '..ohhhHhhhho..',
      '..ohhhho.hho..',
      '..ohho....ho..',
      '...oo.........',
      '..............',
      '..............',
      '..............',
      '..............',
    ],
    side: [
      '..ohhhhhhhho..',
      '..ohhhhhhhho..',
      '..ohhhHhhhho..',
      '..ohhhhh.hho..',
      '..ohhho....o..',
      '..ohho........',
      '...oo.........',
      '..............',
      '..............',
      '..............',
    ],
  },
  // 4 — twin tails
  {
    front: [
      '..ohhhhhhhho..',
      '.oohhhhhhhhoo.',
      '.ohhhHhhhHhho.',
      '.ohho....ohho.',
      '.ohh......hho.',
      '.ohh......hho.',
      '..oo......oo..',
      '..............',
      '..............',
      '..............',
    ],
    side: [
      '..ohhhhhhhho..',
      '.oohhhhhhhho..',
      '.ohhhHhhhhho..',
      '.ohhhh...hho..',
      '.ohhho........',
      '.ohhho........',
      '..ooo.........',
      '..............',
      '..............',
      '..............',
    ],
  },
  // 5 — slicked back, long braid
  {
    front: [
      '..ohhhhhhhho..',
      '..ohHhhhhHho..',
      '..ohhhhhhhho..',
      '...oh....ho...',
      '....o....o....',
      '..............',
      '..............',
      '..............',
      '..............',
      '..............',
    ],
    side: [
      '..ohhhhhhhho..',
      '..ohHhhhhhho..',
      '..ohhhhhhhho..',
      '..ohhh...hho..',
      '..ohho........',
      '...ohho.......',
      '...ohho.......',
      '...ohho.......',
      '....oo........',
      '..............',
    ],
  },
];

export interface Archetype {
  hair: number;
  hairLight: number;
}

export const ARCHETYPES: readonly Archetype[] = [
  { hair: 0xb33a35, hairLight: 0xe07a6a },
  { hair: 0x4a7fb5, hairLight: 0x8fc0e8 },
  { hair: 0xd8dde8, hairLight: 0xffffff },
  { hair: 0x2e2b3d, hairLight: 0x5e5878 },
  { hair: 0x5f8f5a, hairLight: 0x9fd49a },
  { hair: 0xc2a45e, hairLight: 0xf0d9a0 },
  // Four more fighters reuse the hairstyles above with their own colouring.
  { hair: 0x1f1f2a, hairLight: 0x4b4b60 },
  { hair: 0xd27a9c, hairLight: 0xf4b9cf },
  { hair: 0xb2622c, hairLight: 0xe39a63 },
  { hair: 0x9b8fd1, hairLight: 0xd3cbf5 },
];

const OUTLINE = 0x12141c;
const SKIN = 0xe8b894;
const SKIN_SHADE = 0xb8835f;
const EYE = 0x1a1a24;
const BOOT = 0x23262e;
const GEAR = 0x3a4049;

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

export interface Sprite {
  /** Row-major colours, -1 where the sprite is transparent. */
  pixels: Int32Array;
  width: number;
  height: number;
}

const cache = new Map<string, Sprite>();

function assertRows(rows: readonly string[], label: string): void {
  for (const [i, row] of rows.entries()) {
    if (row.length !== SPRITE_W) {
      throw new Error(`${label} row ${i} is ${row.length} px wide, expected ${SPRITE_W}`);
    }
  }
}

/** Composites body, legs and hair into one flat pixel grid, then caches it. */
export function sprite(facing: Facing, frame: number, archetype: number, suit: number): Sprite {
  const key = `${facing}:${frame}:${archetype}:${suit}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const look = ARCHETYPES[archetype % ARCHETYPES.length]!;
  const hair = HAIR[archetype % HAIR.length]!;
  const palette: Record<string, number> = {
    o: OUTLINE,
    s: SKIN,
    S: SKIN_SHADE,
    e: EYE,
    h: look.hair,
    H: look.hairLight,
    j: suit,
    J: shade(suit, 1.3),
    k: shade(suit, 0.62),
    t: shade(suit, 0.45),
    b: BOOT,
    g: GEAR,
  };

  const body = BODY[facing];
  const legs = LEGS[frame % LEGS.length]!;
  const crown = facing === 'side' ? hair.side : hair.front;
  assertRows(body, `body/${facing}`);
  assertRows(legs, `legs/${frame}`);
  assertRows(crown, `hair/${archetype}/${facing}`);

  const pixels = new Int32Array(SPRITE_W * SPRITE_H).fill(-1);

  const put = (rows: readonly string[], offsetY: number) => {
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y]!;
      for (let x = 0; x < SPRITE_W; x++) {
        const cell = row[x]!;
        if (cell === '.') continue;
        const color = palette[cell];
        if (color === undefined) continue;
        const py = y + offsetY;
        if (py < 0 || py >= SPRITE_H) continue;
        pixels[py * SPRITE_W + x] = color;
      }
    }
  };

  put(body, 0);
  put(legs, BODY_H);

  // Seen from behind there is no face, so the fringe becomes a full head of hair.
  if (facing === 'up') {
    for (let y = 1; y <= 7; y++) {
      for (let x = 3; x <= 10; x++) {
        const i = y * SPRITE_W + x;
        if (pixels[i] === SKIN || pixels[i] === SKIN_SHADE) pixels[i] = look.hair;
      }
    }
  }
  put(crown, 0);

  const built: Sprite = { pixels, width: SPRITE_W, height: SPRITE_H };
  cache.set(key, built);
  return built;
}

/** Four-way facing from an aim angle, with the side views mirrored. */
export function facingFor(aim: number): { facing: Facing; flip: boolean } {
  const a = ((aim % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const deg = (a * 180) / Math.PI;
  if (deg >= 50 && deg < 130) return { facing: 'down', flip: false };
  if (deg >= 130 && deg < 230) return { facing: 'side', flip: true };
  if (deg >= 230 && deg < 310) return { facing: 'up', flip: false };
  return { facing: 'side', flip: false };
}
