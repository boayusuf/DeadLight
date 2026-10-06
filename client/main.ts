import './style.css';
import {
  ARENA_BASE_SIZE,
  MAX_PLAYERS,
  PLAYER_RADIUS,
  PLAYER_COLORS,
  RESOLVE_DELAY_MS,
  SHRINK_WARN_MS,
  TICK_MS,
} from '../shared/constants.js';
import { clampToArena } from '../shared/arena.js';
import { stepPlayer } from '../shared/movement.js';
import type { ServerMessage } from '../shared/protocol.js';
import { Sfx } from './audio.js';
import { Input, touchDevice } from './input.js';
import { Net } from './net.js';
import { Prediction } from './prediction.js';
import { Renderer, type Scene } from './render.js';
import { SPRITE_H, SPRITE_W, sprite } from './sprites.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const dom = {
  overlay: el('overlay'),
  menu: el('panel-menu'),
  lobby: el('panel-lobby'),
  result: el('panel-result'),
  flash: el('flash'),
  name: el<HTMLInputElement>('name'),
  code: el<HTMLInputElement>('code'),
  codeForm: el<HTMLFormElement>('form-code'),
  menuError: el('menu-error'),
  lobbyTitle: el('lobby-title'),
  lobbySub: el('lobby-sub'),
  lobbyCodeRow: el('lobby-code-row'),
  lobbyCode: el('lobby-code'),
  lobbyCount: el('lobby-count'),
  lobbyPlayers: el('lobby-players'),
  lobbyColors: el('lobby-colors'),
  resultTitle: el('result-title'),
  resultDetail: el('result-detail'),
  resultStandings: el('result-standings'),
  resultSprite: el<HTMLCanvasElement>('result-sprite'),
  btnPublic: el<HTMLButtonElement>('btn-public'),
  btnCreate: el<HTMLButtonElement>('btn-create'),
  btnReady: el<HTMLButtonElement>('btn-ready'),
  btnStart: el<HTMLButtonElement>('btn-start'),
  btnLeave: el<HTMLButtonElement>('btn-leave'),
  btnAgain: el<HTMLButtonElement>('btn-again'),
};

const stage = el<HTMLCanvasElement>('stage');
const renderer = new Renderer(stage);
const input = new Input(stage);
const sfx = new Sfx();
const prediction = new Prediction();

const rgb = (hex: string) => parseInt(hex.slice(1), 16);
/** Each colour slot owns a fighter design, so a colour always reads as a face. */
const archetypeOf = (hex: string) => Math.max(0, PLAYER_COLORS.indexOf(hex as never));

const scene: Scene = {
  selfId: '',
  roster: new Map(),
  baseSize: ARENA_BASE_SIZE[6]!,
  phase: 'lights',
  lights: null,
  lightsAt: 0,
  darkAt: 0,
  darkEndsAt: 0,
  self: null,
  watch: [],
  scorches: [],
  spectating: false,
  inMatch: false,
};

let panel: 'menu' | 'lobby' | 'result' | null = 'menu';
let nextTickAt = 0;
let countdownEndsAt: number | null = null;
let ready = false;
/** The result card waits for the final beams to clear; a new match cancels it. */
let resultTimer = 0;
let leavingResult = false;
let lastStep = 0;

const net = new Net(handle, () => {
  scene.inMatch = false;
  show('menu');
  dom.menuError.textContent = 'Connection lost.';
});

function show(next: typeof panel): void {
  panel = next;
  dom.menu.hidden = next !== 'menu';
  dom.lobby.hidden = next !== 'lobby';
  dom.result.hidden = next !== 'result';
  dom.overlay.classList.toggle('hidden', next === null);
}

function swatch(color: string): HTMLElement {
  const dot = document.createElement('b');
  dot.style.background = color;
  return dot;
}

/** Paints a fighter into the result card at whole-pixel scale. */
function paintSprite(canvas: HTMLCanvasElement, archetype: number, color: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const art = sprite('down', 0, archetype, color);
  const image = ctx.createImageData(SPRITE_W, SPRITE_H);
  for (let i = 0; i < art.pixels.length; i++) {
    const value = art.pixels[i]!;
    const o = i << 2;
    if (value < 0) continue;
    image.data[o] = value >> 16;
    image.data[o + 1] = (value >> 8) & 0xff;
    image.data[o + 2] = value & 0xff;
    image.data[o + 3] = 255;
  }
  canvas.width = SPRITE_W;
  canvas.height = SPRITE_H;
  ctx.putImageData(image, 0, 0);
}

/** One button per colour, each showing the fighter that colour belongs to. */
const picks = PLAYER_COLORS.map((color) => {
  const button = document.createElement('button');
  button.className = 'pick';
  button.title = color;
  button.style.borderBottomColor = color;
  const canvas = document.createElement('canvas');
  paintSprite(canvas, archetypeOf(color), rgb(color));
  button.append(canvas);
  button.addEventListener('click', () => net.send({ t: 'color', color }));
  dom.lobbyColors.append(button);
  return { color, button };
});

function handle(msg: ServerMessage): void {
  switch (msg.t) {
    case 'lobby': {
      scene.selfId = msg.selfId;
      countdownEndsAt = msg.countdownMs === null ? null : performance.now() + msg.countdownMs;
      ready = msg.players.find((p) => p.id === msg.selfId)?.ready ?? false;

      dom.lobbyTitle.textContent = msg.code ? 'Party' : 'Matchmaking';
      dom.lobbyCodeRow.hidden = !msg.code;
      dom.lobbyCode.textContent = msg.code ?? '';
      dom.lobbyCount.textContent = `${msg.players.length}/${MAX_PLAYERS}`;
      dom.btnStart.hidden = !msg.code || !msg.host;
      dom.btnStart.disabled = msg.players.length < 2;
      dom.btnReady.classList.toggle('on', ready);
      dom.btnReady.textContent = ready ? 'Ready ×' : 'Ready';

      const mine = msg.players.find((p) => p.id === msg.selfId)?.color;
      const taken = new Set(msg.players.map((p) => p.color));
      for (const { color, button } of picks) {
        button.classList.toggle('mine', color === mine);
        button.disabled = color !== mine && taken.has(color);
      }

      dom.lobbyPlayers.replaceChildren(
        ...msg.players.map((p) => {
          const row = document.createElement('li');
          row.classList.toggle('ready', p.ready);
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = p.ready ? 'Ready' : 'Standby';
          row.append(swatch(p.color), document.createTextNode(p.name), tag);
          return row;
        }),
      );

      // The room drops back to its lobby the moment a match ends, which must
      // not yank the result card out from under the player.
      if (!scene.inMatch && (panel !== 'result' || leavingResult)) {
        leavingResult = false;
        show('lobby');
      }
      return;
    }

    case 'match': {
      scene.roster = new Map(
        msg.players.map((p) => [
          p.id,
          { name: p.name, color: rgb(p.color), archetype: archetypeOf(p.color) },
        ]),
      );
      scene.baseSize = ARENA_BASE_SIZE[msg.startCount] ?? ARENA_BASE_SIZE[6]!;
      scene.scorches = [];
      scene.watch = [];
      scene.spectating = false;
      scene.inMatch = true;
      countdownEndsAt = null;
      clearTimeout(resultTimer);
      renderer.configure(scene.baseSize);
      renderer.clearEffects();
      show(null);
      return;
    }

    case 'lights': {
      const now = performance.now();
      const shrinking = scene.lights !== null && msg.size !== msg.previousSize;
      scene.lights = msg;
      scene.lightsAt = now;
      scene.phase = 'lights';
      prediction.reset();
      sfx.stopHum();

      const me = msg.players.find((p) => p.id === scene.selfId);
      scene.self = me?.alive ? { x: me.x, y: me.y, aim: me.aim } : null;
      if (scene.inMatch && !scene.self) scene.spectating = true;

      if (msg.resolution) {
        const resolution = msg.resolution;
        renderer.reveal(now);
        sfx.clack();
        window.setTimeout(() => sfx.impact(), 150);

        const killers = new Set(resolution.kills.map((k) => k.shooter));
        for (const beam of resolution.beams) {
          if (killers.has(beam.id)) scene.scorches.push(beam);
        }
        if (resolution.eliminated.includes(scene.selfId)) flashRed();

        window.setTimeout(() => {
          for (const id of resolution.eliminated) {
            const victim = msg.players.find((p) => p.id === id);
            const fighter = scene.roster.get(id);
            if (!victim || !fighter) continue;
            renderer.burst(victim.x, victim.y, fighter.color, performance.now());
            renderer.mark(victim, fighter, performance.now());
          }
          if (resolution.eliminated.length > 0) sfx.kill();
        }, RESOLVE_DELAY_MS);
      }

      if (shrinking) {
        window.setTimeout(() => sfx.warn(), RESOLVE_DELAY_MS);
        window.setTimeout(() => sfx.thud(), RESOLVE_DELAY_MS + SHRINK_WARN_MS);
      }
      return;
    }

    case 'dark': {
      scene.phase = 'dark';
      scene.darkAt = performance.now();
      scene.darkEndsAt = scene.darkAt + msg.durationMs;
      prediction.reset();
      // The snapshot showed where you fired from; start moving from where the
      // shrunken wall actually left you.
      if (scene.self && scene.lights) {
        const inside = clampToArena(scene.self, scene.lights.size, PLAYER_RADIUS);
        scene.self.x = inside.x;
        scene.self.y = inside.y;
      }
      nextTickAt = 0;
      sfx.startHum();
      return;
    }

    case 'self': {
      if (!scene.self) return;
      const corrected = prediction.reconcile(msg, scene.self);
      scene.self.x = corrected.x;
      scene.self.y = corrected.y;
      return;
    }

    case 'watch':
      scene.watch = msg.players;
      return;

    case 'over': {
      // The final reveal has already played, so drop the round and let the
      // arena behind the result card go back to full size.
      scene.inMatch = false;
      scene.lights = null;
      scene.spectating = false;
      renderer.clearEffects();
      sfx.stopHum();

      const won = msg.winner === scene.selfId;
      const champion = msg.winner ? scene.roster.get(msg.winner) : undefined;
      if (won) sfx.win();

      dom.resultTitle.textContent = won ? 'Victory' : champion ? 'Eliminated' : 'Draw';
      dom.resultTitle.className = won ? 'victory' : champion ? '' : 'draw';
      dom.resultDetail.textContent = won
        ? `Last standing after ${msg.rounds} rounds`
        : champion
          ? `${champion.name} took it`
          : 'Everyone went down at once';

      const portrait = champion ?? scene.roster.get(scene.selfId);
      dom.resultSprite.hidden = !portrait;
      if (portrait) paintSprite(dom.resultSprite, portrait.archetype, portrait.color);

      dom.resultStandings.replaceChildren(
        ...msg.standings.map((standing, i) => {
          const fighter = scene.roster.get(standing.id);
          const row = document.createElement('li');
          if (standing.id === msg.winner) row.classList.add('winner');

          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent =
            standing.id === msg.winner
              ? 'Won'
              : `R${String(standing.roundsSurvived).padStart(2, '0')}`;

          row.append(
            swatch(fighter ? `#${fighter.color.toString(16).padStart(6, '0')}` : '#ccd6e2'),
            document.createTextNode(`${i + 1}. ${fighter?.name ?? '???'}`),
            tag,
          );
          return row;
        }),
      );

      resultTimer = window.setTimeout(() => {
        if (!scene.inMatch) show('result');
      }, 700);
      return;
    }

    case 'err':
      dom.menuError.textContent = msg.msg;
      show('menu');
      return;
  }
}

function flashRed(): void {
  dom.flash.classList.add('on');
  window.setTimeout(() => dom.flash.classList.remove('on'), 150);
}

/** Tightens as the blackout runs on, so the pressure is audible. */
function tickInterval(elapsed: number): number {
  return Math.max(110, 560 - elapsed * 0.17);
}

let lastFrame = performance.now();

function loop(now: number): void {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  const dir = scene.phase === 'dark' ? input.direction() : { x: 0, y: 0 };
  const walking = dir.x !== 0 || dir.y !== 0;
  renderer.setMoving(walking);

  if (scene.phase === 'dark' && scene.lights) {
    if (scene.self) {
      const moved = stepPlayer(scene.self, dir.x, dir.y, dt, scene.lights.size);
      scene.self.x = moved.x;
      scene.self.y = moved.y;

      const target = renderer.worldFromScreen(input.pointer.x, input.pointer.y);
      scene.self.aim = Math.atan2(target.y - scene.self.y, target.x - scene.self.x);

      if (walking && now - lastStep > 190) {
        lastStep = now;
        sfx.step();
      }
    }

    // A backgrounded tab stops painting, so resync rather than trying to catch
    // up every missed tick at once.
    const elapsed = now - scene.darkAt;
    if (elapsed - nextTickAt > 600) nextTickAt = elapsed;
    while (elapsed >= nextTickAt) {
      sfx.tick(Math.min(elapsed / 2600, 1));
      nextTickAt += tickInterval(elapsed);
    }
  }

  if (panel === 'lobby') {
    dom.lobbySub.textContent =
      countdownEndsAt === null
        ? 'Waiting for fighters'
        : `Launching in ${Math.max(0, Math.ceil((countdownEndsAt - now) / 1000))}`;
  }

  renderer.frame(scene, now);
  requestAnimationFrame(loop);
}

setInterval(() => {
  if (scene.phase !== 'dark' || !scene.self) return;
  const dir = input.direction();
  const seq = prediction.record(scene.self.x, scene.self.y);
  net.send({ t: 'input', seq, mx: dir.x, my: dir.y, aim: scene.self.aim });
}, TICK_MS);

async function join(mode: 'public' | 'create' | 'code'): Promise<void> {
  sfx.enable();
  dom.menuError.textContent = '';
  const name = dom.name.value.trim();
  localStorage.setItem('deadlight.name', name);

  try {
    await net.connect();
  } catch {
    dom.menuError.textContent = 'Could not reach the server.';
    return;
  }

  if (mode === 'code') net.send({ t: 'join', name, mode, code: dom.code.value });
  else net.send({ t: 'join', name, mode });
}

dom.name.value = localStorage.getItem('deadlight.name') ?? '';
el('touch-hint').hidden = !touchDevice;
dom.btnPublic.addEventListener('click', () => void join('public'));
dom.btnCreate.addEventListener('click', () => void join('create'));
dom.codeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (dom.code.value.trim().length === 4) void join('code');
});
dom.btnReady.addEventListener('click', () => net.send({ t: 'ready', value: !ready }));
dom.btnStart.addEventListener('click', () => net.send({ t: 'start' }));
// The server's next lobby message moves the view, so a dead socket cannot
// strand the player in an empty lobby.
dom.btnAgain.addEventListener('click', () => {
  leavingResult = true;
  net.send({ t: 'again' });
});
dom.btnLeave.addEventListener('click', () => location.reload());
dom.lobbyCode.addEventListener('click', () => {
  if (dom.lobbyCode.textContent) void navigator.clipboard?.writeText(dom.lobbyCode.textContent);
});

show('menu');
requestAnimationFrame(loop);
