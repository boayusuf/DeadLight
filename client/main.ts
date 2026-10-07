import './style.css';
import {
  ARENA_BASE_SIZE,
  DEFAULT_FINISHER,
  FINISHERS,
  FINISHER_NAMES,
  FUNNY_FINISHERS,
  KILLCAM_MS,
  MAX_PLAYERS,
  PLAYER_RADIUS,
  PLAYER_COLORS,
  RESOLVE_DELAY_MS,
  SHRINK_WARN_MS,
  STANDARD_ARENA,
  TICK_MS,
  isFinisher,
  type FinisherId,
} from '../shared/constants.js';
import { arenaSize } from '../shared/arena.js';
import {
  MAP_BLURBS,
  MAP_IDS,
  MAP_NAMES,
  collide,
  layoutFor,
  openWorld,
  padUnder,
  teleportStep,
  type MapChoice,
} from '../shared/maps.js';
import { stepPlayer } from '../shared/movement.js';
import type { ServerMessage, Standing } from '../shared/protocol.js';
import type { Resolution } from '../shared/resolve.js';
import { Sfx } from './audio.js';
import { calloutFor, killerOf } from './callouts.js';
import { finisherSound, previewFinisher } from './finishers.js';
import { Input, touchDevice } from './input.js';
import { beatAt, type KillcamBeat } from './killcam.js';
import { finaleSound, killscreenSound } from './killscreen.js';
import { obstacleSound } from './obstacles.js';
import { Music } from './music.js';
import { Net } from './net.js';
import { Prediction } from './prediction.js';
import { HIT_STOP_MS, INTRO_MS, Renderer, type Scene } from './render.js';
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
  resultStats: el('result-stats'),
  finisherName: el('finisher-name'),
  finisherPicks: el('lobby-finishers'),
  finisherPreview: el<HTMLCanvasElement>('finisher-preview'),
  btnMusic: el<HTMLButtonElement>('btn-music'),
  mapName: el('map-name'),
  mapBlurb: el('map-blurb'),
  mapPicks: el('lobby-maps'),
  botRow: el('lobby-bots'),
  btnBot: el<HTMLButtonElement>('btn-bot'),
  btnBotLevel: el<HTMLButtonElement>('btn-bot-level'),
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
const music = new Music();
const prediction = new Prediction();

const rgb = (hex: string) => parseInt(hex.slice(1), 16);
/** Each colour slot owns a fighter design, so a colour always reads as a face. */
const archetypeOf = (hex: string) => Math.max(0, PLAYER_COLORS.indexOf(hex as never));

const scene: Scene = {
  selfId: '',
  roster: new Map(),
  baseSize: STANDARD_ARENA,
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
  showdown: false,
  killcam: null,
  world: openWorld(STANDARD_ARENA),
};

let panel: 'menu' | 'lobby' | 'result' | null = 'menu';
let nextTickAt = 0;
let countdownEndsAt: number | null = null;
let ready = false;
/** The result card waits for the final beams to clear; a new match cancels it. */
let resultTimer = 0;
/** Between the match ending and the result card: the lobby must not cut in. */
let resultPending = false;
let leavingResult = false;
let lastStep = 0;
/** Set once the final position of a blackout has been sent. */
let locked = false;
/** The teleporter pad the fighter is standing on and has already used, if any. */
let onPad: string | null = null;
/** Fighters still standing as of the last lights, to spot the drop to two. */
let lastRemaining = 0;
let bloodDrawn = false;
/** The killcam beat whose sound has played, so each cue fires once. */
let cueBeat: KillcamBeat | null = null;
let finisher: FinisherId = readFinisher();
let myColor: string = PLAYER_COLORS[0];
let stopPreview: (() => void) | null = null;

function readFinisher(): FinisherId {
  try {
    const stored = localStorage.getItem('deadlight.finisher');
    return isFinisher(stored) ? stored : DEFAULT_FINISHER;
  } catch {
    return DEFAULT_FINISHER;
  }
}

const net = new Net(handle, () => {
  scene.inMatch = false;
  scene.killcam = null;
  music.stop();
  show('menu');
  dom.menuError.textContent = 'Connection lost.';
});

function show(next: typeof panel): void {
  const previous = panel;
  panel = next;
  dom.menu.hidden = next !== 'menu';
  dom.lobby.hidden = next !== 'lobby';
  dom.result.hidden = next !== 'result';
  dom.overlay.classList.toggle('hidden', next === null);
  // Every lobby update re-shows the lobby; only arriving there restarts the loop.
  if (next === 'lobby' && previous !== 'lobby') preview();
  if (next !== 'lobby') {
    stopPreview?.();
    stopPreview = null;
  }
}

/** Phones only; a no-op wherever vibration is unsupported. */
function buzz(pattern: number | number[]): void {
  navigator.vibrate?.(pattern);
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

/** Loops your finisher on your own fighter, so you see what you are picking. */
function preview(): void {
  stopPreview?.();
  stopPreview = previewFinisher(dom.finisherPreview, finisher, rgb(myColor), archetypeOf(myColor));
}

function pickFinisher(next: FinisherId): void {
  finisher = next;
  try {
    localStorage.setItem('deadlight.finisher', next);
  } catch {
    // Private mode: the pick still holds for this session.
  }
  net.send({ t: 'finisher', finisher: next });
  showFinisher();
  if (panel === 'lobby') preview();
}

/** Classic first, then the cartoon ones, each under its own small heading. */
const finisherPicks = [false, true].flatMap((funny) => {
  const heading = document.createElement('span');
  heading.className = 'group';
  heading.textContent = funny ? 'Funny' : 'Classic';
  dom.finisherPicks.append(heading);
  return FINISHERS.filter((kind) => FUNNY_FINISHERS.includes(kind) === funny).map((kind) => {
    const button = document.createElement('button');
    button.className = 'key';
    button.textContent = FINISHER_NAMES[kind];
    button.addEventListener('click', () => pickFinisher(kind));
    dom.finisherPicks.append(button);
    return { kind, button };
  });
});

const BOT_LEVELS = ['easy', 'normal', 'hard'] as const;
let botLevel: (typeof BOT_LEVELS)[number] = 'normal';
let isHost = false;

/** Random first, then every arena. Only the host's buttons do anything. */
const mapPicks = (['random', ...MAP_IDS] as MapChoice[]).map((map) => {
  const button = document.createElement('button');
  button.className = 'key';
  button.textContent = map === 'random' ? 'Random' : MAP_NAMES[map];
  button.addEventListener('click', () => net.send({ t: 'map', map }));
  dom.mapPicks.append(button);
  return { map, button };
});

function showMap(choice: MapChoice, host: boolean, party: boolean): void {
  dom.mapName.textContent = choice === 'random' ? 'Random' : MAP_NAMES[choice];
  dom.mapBlurb.textContent = choice === 'random' ? 'A different arena every match.' : MAP_BLURBS[choice];
  for (const { map, button } of mapPicks) {
    button.classList.toggle('mine', map === choice);
    button.disabled = !host || !party;
  }
}

function showFinisher(): void {
  dom.finisherName.textContent = FINISHER_NAMES[finisher];
  for (const { kind, button } of finisherPicks) button.classList.toggle('mine', kind === finisher);
}

function showMusic(): void {
  dom.btnMusic.textContent = `Music ${music.muted ? 'off' : 'on'} \u00b7 M`;
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
      isHost = msg.host;
      dom.botRow.hidden = !msg.code || !msg.host;
      dom.btnBot.disabled = msg.players.length >= MAX_PLAYERS;
      showMap(msg.map, msg.host, msg.code !== null);
      dom.btnReady.classList.toggle('on', ready);
      dom.btnReady.textContent = ready ? 'Ready ×' : 'Ready';

      const mine = msg.players.find((p) => p.id === msg.selfId)?.color;
      if (mine && mine !== myColor) {
        myColor = mine;
        if (panel === 'lobby') preview();
      }
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
          tag.textContent = p.bot ? 'Bot' : p.ready ? 'Ready' : 'Standby';
          row.append(swatch(p.color), document.createTextNode(p.name));
          if (p.wins > 0) row.append(label('wins', `${p.wins}W`));
          row.append(tag);
          if (p.bot && isHost && msg.code) row.append(kickButton(p.id));
          return row;
        }),
      );

      // The room drops back to its lobby the moment a match ends, which must
      // not yank the result card out from under the player.
      if (!scene.inMatch && !resultPending && (panel !== 'result' || leavingResult)) {
        leavingResult = false;
        show('lobby');
      }
      return;
    }

    case 'match': {
      scene.roster = new Map(
        msg.players.map((p) => [
          p.id,
          { name: p.name, color: rgb(p.color), archetype: archetypeOf(p.color), finisher: p.finisher },
        ]),
      );
      scene.baseSize = ARENA_BASE_SIZE[msg.startCount] ?? STANDARD_ARENA;
      scene.world = {
        size: scene.baseSize,
        layout: layoutFor(msg.map, arenaSize(msg.startCount, 0)),
        broken: new Set(),
      };
      scene.scorches = [];
      scene.watch = [];
      scene.spectating = false;
      scene.inMatch = true;
      scene.showdown = false;
      scene.killcam = null;
      lastRemaining = msg.startCount;
      bloodDrawn = false;
      music.setShowdown(false);
      music.start();
      countdownEndsAt = null;
      clearTimeout(resultTimer);
      resultPending = false;
      renderer.configure(scene.baseSize);
      renderer.clearEffects();
      show(null);
      return;
    }

    case 'lights': {
      const now = performance.now();
      const shrinking = scene.lights !== null && msg.size !== msg.previousSize;
      const entering = msg.remaining === 2 && !msg.replay && (lastRemaining > 2 || msg.round === 0);
      lastRemaining = msg.remaining;
      const before = scene.world;
      scene.world = { ...before, size: msg.size, broken: new Set(msg.broken) };
      scene.lights = msg;
      scene.lightsAt = now;
      scene.phase = 'lights';
      prediction.reset();
      sfx.stopHum();
      // Killcam first, so the lights coming back do not fire the music's drop.
      if (msg.replay) music.setKillcam(true);
      music.setDark(false);
      music.setStage(msg.stage);

      const me = msg.players.find((p) => p.id === scene.selfId);
      scene.self = me?.alive ? { x: me.x, y: me.y, aim: me.aim } : null;
      if (scene.inMatch && !scene.self) scene.spectating = true;

      // The match-ending round is told by the killcam, not the usual reveal.
      if (msg.replay) {
        const intact = new Set(msg.broken.filter((id) => !msg.resolution?.broken.includes(id)));
        scene.killcam = {
          startedAt: now,
          lights: msg,
          spawned: false,
          world: { ...scene.world, size: before.size, broken: intact },
        };
        cueBeat = null;
        return;
      }

      if (msg.resolution) reveal(msg, msg.resolution, now);
      if (entering) {
        const at = Math.max(RESOLVE_DELAY_MS + HIT_STOP_MS + 100, msg.holdMs - INTRO_MS - 150);
        window.setTimeout(() => enterShowdown(msg.players.map((p) => p.id)), msg.round === 0 ? 150 : at);
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
      locked = false;
      prediction.reset();
      // The snapshot showed where you fired from; start moving from where the
      // shrunken wall actually left you.
      if (scene.self && scene.lights) {
        const inside = collide(scene.self, PLAYER_RADIUS, scene.world);
        onPad = padUnder(inside, scene.world);
        scene.self.x = inside.x;
        scene.self.y = inside.y;
      }
      nextTickAt = 0;
      sfx.startHum();
      music.setDark(true);
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
      scene.spectating = false;
      scene.showdown = false;
      sfx.stopHum();
      music.stop();

      const won = msg.winner === scene.selfId;
      const champion = msg.winner ? scene.roster.get(msg.winner) : undefined;
      if (!scene.killcam && won) sfx.win();
      dom.resultStats.textContent = personalStats(msg.standings.find((s) => s.id === scene.selfId));

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

          const tag = label(
            'tag',
            standing.id === msg.winner ? 'Won' : `R${String(standing.roundsSurvived).padStart(2, '0')}`,
          );

          row.append(
            swatch(fighter ? `#${fighter.color.toString(16).padStart(6, '0')}` : '#ccd6e2'),
            document.createTextNode(`${i + 1}. ${fighter?.name ?? '???'}`),
            label('stat', `${standing.kills}K \u00b7 ${msg.wins[standing.id] ?? 0}W`),
            tag,
          );
          return row;
        }),
      );

      // The result card waits for the killcam to play out, finale card and all.
      const killcamLeft = scene.killcam ? scene.killcam.startedAt + KILLCAM_MS - performance.now() : 0;
      resultPending = true;
      resultTimer = window.setTimeout(() => {
        resultPending = false;
        scene.killcam = null;
        scene.lights = null;
        renderer.clearEffects();
        if (!scene.inMatch) show('result');
      }, Math.max(0, killcamLeft) + 450);
      return;
    }

    case 'err':
      dom.menuError.textContent = msg.msg;
      show('menu');
      return;
  }
}

/**
 * Lights on: beams land, a hit-stop holds the frame, then the finishers go
 * off with the feed, the callout and the haptics.
 */
function reveal(msg: Extract<ServerMessage, { t: 'lights' }>, resolution: Resolution, now: number): void {
  renderer.reveal(now);
  sfx.clack();
  window.setTimeout(() => sfx.impact(), 150);
  if (resolution.beams.some((b) => b.segments.length > 1)) window.setTimeout(() => roomSound('bounce'), 120);
  buzz(12);

  const killers = new Set(resolution.kills.map((k) => k.shooter));
  for (const beam of resolution.beams) {
    if (killers.has(beam.id)) scene.scorches.push(...beam.segments);
  }
  if (resolution.eliminated.includes(scene.selfId)) {
    flashRed();
    buzz([90, 40, 160]);
  }

  const struck = resolution.eliminated.length > 0;
  if (struck) window.setTimeout(() => renderer.hitStop(performance.now(), HIT_STOP_MS), RESOLVE_DELAY_MS);
  window.setTimeout(() => aftermath(msg, resolution), RESOLVE_DELAY_MS + (struck ? HIT_STOP_MS : 0));
}

function aftermath(msg: Extract<ServerMessage, { t: 'lights' }>, resolution: Resolution): void {
  const now = performance.now();
  for (const id of resolution.eliminated) {
    const victim = msg.players.find((p) => p.id === id);
    if (victim) renderer.eliminate(resolution, victim, msg.players, scene.roster, now);
  }
  for (const kill of resolution.kills) {
    const killer = scene.roster.get(kill.shooter);
    const victim = scene.roster.get(kill.target);
    if (killer && victim) renderer.feedKill(killer, victim, now);
  }
  for (const duel of resolution.duels) {
    const a = msg.players.find((p) => p.id === duel.a);
    const b = msg.players.find((p) => p.id === duel.b);
    if (a && b) renderer.sparks((a.x + b.x) / 2, (a.y + b.y) / 2, now);
  }

  for (const id of resolution.broken) {
    const crate = scene.world.layout.obstacles.find((o) => o.id === id);
    if (crate?.kind === 'crate') renderer.crateBroken(crate, now);
  }
  if (resolution.broken.length > 0) roomSound('crate');

  playFinishers(resolution, 1);
  if (resolution.duels.length > 0) sfx.clash();
  if (resolution.kills.some((k) => k.shooter === scene.selfId)) buzz(35);

  const callout = calloutFor(resolution, !bloodDrawn);
  if (resolution.kills.length > 0) bloodDrawn = true;
  if (callout) {
    renderer.announce(callout.title, callout.by ? scene.roster.get(callout.by) ?? null : null, now);
    if (callout.title !== 'CLASH') sfx.callout();
  }
}

/** One sound per finisher kind in play, so a multi-kill does not stack ten. */
function playFinishers(resolution: Resolution, rate: number): void {
  const ctx = sfx.context;
  const out = sfx.output;
  if (!ctx || !out) return;
  const finisherOf = (victim: string) =>
    scene.roster.get(killerOf(resolution, victim) ?? victim)?.finisher ?? DEFAULT_FINISHER;
  const kinds = new Set(resolution.eliminated.map(finisherOf));
  for (const kind of kinds) finisherSound(kind, ctx, out, rate);
}

/** Down to the last two: the intro, the siren and the heavier music. */
function enterShowdown(ids: readonly string[]): void {
  if (!scene.inMatch || scene.killcam) return;
  const pair = ids.filter((id) => scene.lights?.players.find((p) => p.id === id)?.alive);
  const a = scene.roster.get(pair[0] ?? '');
  const b = scene.roster.get(pair[1] ?? '');
  if (!a || !b) return;
  scene.showdown = true;
  renderer.showdown(a, b, performance.now());
  sfx.alarm();
  music.setShowdown(true);
  buzz([30, 50, 30]);
}

/** Each killcam beat gets its sound the moment it starts. */
function killcamCues(now: number): void {
  const kc = scene.killcam;
  if (!kc) return;
  const { beat } = beatAt(now - kc.startedAt);
  if (beat === cueBeat) return;
  cueBeat = beat;
  const ctx = sfx.context;
  const out = sfx.output;
  if (beat === 'intro') sfx.rewind();
  else if (beat === 'shot') sfx.slowSnap();
  else if (beat === 'freeze') {
    sfx.heartbeat();
    buzz(60);
  } else if (beat === 'cutin') {
    if (ctx && out) killscreenSound(ctx, out);
    buzz([40, 30, 40]);
  } else if (beat === 'boom' && kc.lights.resolution) {
    playFinishers(kc.lights.resolution, 0.5);
    buzz(140);
  } else if (beat === 'finale' && ctx && out) {
    finaleSound(ctx, out, kc.lights.players.some((p) => p.alive && p.id === scene.selfId));
  }
}

function personalStats(standing: Standing | undefined): string {
  if (!standing) return '';
  const parts = [`${standing.kills} ${standing.kills === 1 ? 'kill' : 'kills'}`];
  // 40 units is about a metre: a fighter is 56 across.
  if (standing.longest > 0) parts.push(`longest ${(standing.longest / 40).toFixed(1)} m`);
  const nemesis = standing.killedBy ? scene.roster.get(standing.killedBy) : undefined;
  if (nemesis) parts.push(`taken out by ${nemesis.name}`);
  return parts.join(' \u00b7 ');
}

function roomSound(kind: 'crate' | 'teleport' | 'bounce'): void {
  const ctx = sfx.context;
  const out = sfx.output;
  if (ctx && out) obstacleSound(kind, ctx, out);
}

function kickButton(id: string): HTMLElement {
  const button = document.createElement('button');
  button.className = 'kick';
  button.textContent = '\u00d7';
  button.title = 'Remove bot';
  button.addEventListener('click', () => net.send({ t: 'bot', add: false, id }));
  return button;
}

function label(className: string, text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
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

  // At the announced end the fighter freezes and its final position and aim go
  // out at once, so the shot that fires is exactly the one on screen.
  const frozen = scene.phase === 'dark' && now >= scene.darkEndsAt;
  if (frozen && !locked) {
    locked = true;
    sendInput();
  }

  const dir = scene.phase === 'dark' && !frozen ? input.direction() : { x: 0, y: 0 };
  const walking = dir.x !== 0 || dir.y !== 0;
  renderer.setMoving(walking);

  if (scene.phase === 'dark' && scene.lights) {
    if (scene.self && !frozen) {
      const moved = stepPlayer(scene.self, dir.x, dir.y, dt, scene.world);
      const jump = teleportStep(moved, scene.world, onPad);
      onPad = jump.onPad;
      if (jump.jumped) {
        renderer.teleported(moved, jump, scene.roster.get(scene.selfId)?.color ?? 0xccd6e2, now);
        roomSound('teleport');
        buzz(20);
      }
      scene.self.x = jump.x;
      scene.self.y = jump.y;

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

  killcamCues(now);

  if (panel === 'lobby') {
    dom.lobbySub.textContent =
      countdownEndsAt === null
        ? 'Waiting for fighters'
        : `Launching in ${Math.max(0, Math.ceil((countdownEndsAt - now) / 1000))}`;
  }

  renderer.frame(scene, now);
  requestAnimationFrame(loop);
}

function sendInput(): void {
  if (scene.phase !== 'dark' || !scene.self) return;
  const dir = locked ? { x: 0, y: 0 } : input.direction();
  const { x, y, aim } = scene.self;
  const seq = prediction.record(x, y);
  net.send({ t: 'input', seq, mx: dir.x, my: dir.y, aim, x, y });
}

setInterval(sendInput, TICK_MS);

async function join(mode: 'public' | 'create' | 'code'): Promise<void> {
  sfx.enable();
  if (sfx.context && sfx.output) music.attach(sfx.context, sfx.output);
  dom.menuError.textContent = '';
  const name = dom.name.value.trim();
  localStorage.setItem('deadlight.name', name);

  try {
    await net.connect();
  } catch {
    dom.menuError.textContent = 'Could not reach the server.';
    return;
  }

  if (mode === 'code') net.send({ t: 'join', name, finisher, mode, code: dom.code.value });
  else net.send({ t: 'join', name, finisher, mode });
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
dom.btnBot.addEventListener('click', () => net.send({ t: 'bot', add: true, difficulty: botLevel }));
dom.btnBotLevel.addEventListener('click', () => {
  botLevel = BOT_LEVELS[(BOT_LEVELS.indexOf(botLevel) + 1) % BOT_LEVELS.length]!;
  dom.btnBotLevel.textContent = `Level: ${botLevel}`;
});
dom.btnMusic.addEventListener('click', () => {
  music.toggleMute();
  showMusic();
});
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.target instanceof HTMLInputElement) return;
  music.toggleMute();
  showMusic();
});
dom.lobbyCode.addEventListener('click', () => {
  if (dom.lobbyCode.textContent) void navigator.clipboard?.writeText(dom.lobbyCode.textContent);
});

showFinisher();
showMusic();
show('menu');
requestAnimationFrame(loop);
