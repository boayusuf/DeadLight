import './style.css';
import {
  ARENA_BASE_SIZE,
  DEFAULT_FINISHER,
  FINISHERS,
  FINISHER_NAMES,
  FUNNY_FINISHERS,
  KILLCAM_MS,
  MAX_PLAYERS,
  MOVE_SPEED,
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
import {
  GAME_IDS,
  GAME_NAMES,
  gameModeBlurb,
  gameModeMinPlayers,
  gameModeName,
  isMiniGameId,
  type GameChoice,
  type GameMode,
} from '../shared/games.js';
import { MODE_IDS, onPath } from '../shared/modes.js';
import { stepPlayer } from '../shared/movement.js';
import type { LobbyPlayer, ServerMessage, SessionSetup, Standing } from '../shared/protocol.js';
import type { Resolution } from '../shared/resolve.js';
import { Sfx } from './audio.js';
import { calloutFor, killerOf } from './callouts.js';
import { finisherSound, previewFinisher } from './finishers.js';
import { Input, touchDevice } from './input.js';
import { beatAt, type KillcamBeat } from './killcam.js';
import { finaleSound, killscreenSound } from './killscreen.js';
import { obstacleSound } from './obstacles.js';
import { Music } from './music.js';
import { Net, wake } from './net.js';
import { Prediction } from './prediction.js';
import { paintIcon } from './gameicons.js';
import { MiniRenderer, type MiniScene } from './mini.js';
import { HIT_STOP_MS, INTRO_MS, Renderer, type Scene } from './render.js';
import { solidFloor, stepCollapse } from '../shared/collapse.js';
import { stepFreeze } from '../shared/freeze.js';
import { stepPotato } from '../shared/potato.js';
import { ROOM_COUNT, stepRooms } from '../shared/rooms.js';
import { freshFloe } from '../shared/sumo.js';
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
  modeName: el('mode-name'),
  modeBlurb: el('mode-blurb'),
  modePicks: el('lobby-modes'),
  modeSection: el('mode-section'),
  gamePicks: el('game-picks'),
  gameBlurb: el('game-blurb'),
  lobbyGame: el('lobby-game'),
  lobbyGames: el('lobby-games'),
  tabs: el('lobby-tabs'),
  panes: el('lobby-panes'),
  voteSection: el('vote-section'),
  voteMix: el('vote-mix'),
  voteRuns: el('vote-runs'),
  voteRunsTotal: el('vote-runs-total'),
  voteCount: el('vote-count'),
  voteCountTotal: el('vote-count-total'),
  voteGames: el('vote-games'),
  mapSection: el('map-section'),
  touchHint: el('touch-hint'),
  intro: el('intro'),
  introIcon: el<HTMLCanvasElement>('intro-icon'),
  introName: el('intro-name'),
  introRule: el('intro-rule'),
  introLabel: el('intro-label'),
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
const litStage = el<HTMLCanvasElement>('lit-stage');
const renderer = new Renderer(stage);
const litRenderer = new MiniRenderer(litStage);
const input = new Input(stage);
input.attach(litStage);
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
  mode: 'classic',
  round: null,
  brief: null,
  cycle: 0,
};

/** The lit game being played, or null while this is the dark one. */
let lit: MiniScene | null = null;
/** Sumo slides, so between states the fighter is carried on its own momentum. */
let litVelocity: { x: number; y: number } | null = null;

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

/** The four modes. Only the host's buttons do anything, and only in a party. */
/** The seven buttons: six games and a mix of them. */
const GAME_CHOICES: GameChoice[] = [...GAME_IDS, 'mix'];

/** What this player wants to play, picked on the menu before a room exists. */
let wanted: GameChoice = 'deadlight';

/** A card on the menu: the game's own picture over its name. */
const gameCards = GAME_CHOICES.map((game) => {
  const button = document.createElement('button');
  button.className = game === 'mix' ? 'game mix' : 'game';
  const pixel = document.createElement('canvas');
  pixel.className = 'pixel';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = game === 'mix' ? 'Mix' : GAME_NAMES[game];
  button.append(pixel, name);
  button.addEventListener('click', () => {
    wanted = game;
    showWanted();
    if (panel === 'lobby') net.send({ t: 'mode', mode: game });
  });
  dom.gamePicks.append(button);
  return { game, button, pixel };
});

/** The same seven in the lobby, where only the host may press them. */
const gamePicks = GAME_CHOICES.map((game) => {
  const button = document.createElement('button');
  button.className = 'key mode';
  const pixel = document.createElement('canvas');
  pixel.className = 'pixel';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = game === 'mix' ? 'Mix' : GAME_NAMES[game];
  button.append(pixel, name);
  button.addEventListener('click', () => net.send({ t: 'mode', mode: game }));
  dom.lobbyGames.append(button);
  return { game, button, pixel };
});

/** The dark game's own four modes, shown only when it is the game. */
const modePicks = MODE_IDS.map((mode) => {
  const button = document.createElement('button');
  button.className = 'key';
  button.textContent = gameModeName(mode);
  button.addEventListener('click', () => net.send({ t: 'mode', mode }));
  dom.modePicks.append(button);
  return { mode, button };
});

/** Which games 'mix' may draw from. */
const poolPicks = GAME_IDS.map((game) => {
  const button = document.createElement('button');
  button.className = 'key';
  button.textContent = GAME_NAMES[game];
  button.addEventListener('click', () => {
    const pool = new Set(session.games);
    if (pool.has(game)) pool.delete(game);
    else pool.add(game);
    if (pool.size === 0) return;
    net.send({ t: 'session', games: [...pool] });
  });
  dom.voteGames.append(button);
  return { game, button };
});

/** Runs, and games per run: a row of numbers, the chosen one lit. */
function stepper(host: HTMLElement, from: number, to: number, send: (value: number) => void) {
  const steps = [];
  for (let value = from; value <= to; value++) {
    const button = document.createElement('button');
    button.className = 'key';
    button.textContent = String(value);
    button.addEventListener('click', () => send(value));
    host.append(button);
    steps.push({ value, button });
  }
  return steps;
}

const runSteps = stepper(dom.voteRuns, 1, 5, (runs) => net.send({ t: 'session', runs }));
const countSteps = stepper(dom.voteCount, 1, 9, (count) => net.send({ t: 'session', count }));

/** The session as the room last described it. */
let session: SessionSetup = { runs: 1, count: 3, games: [...GAME_IDS] };


/** The lobby's three panes. On a phone they swipe; the tabs drive the scroll. */
const TABS = ['players', 'game', 'look'] as const;
const tabButtons = TABS.map((name) => el<HTMLButtonElement>(`tab-${name}`));
const tabPanes = TABS.map((name) => el(`pane-${name}`));

function showTab(index: number, scroll = true): void {
  tabButtons.forEach((button, i) => {
    button.setAttribute('aria-selected', String(i === index));
    button.tabIndex = i === index ? 0 : -1;
  });
  if (!scroll) return;
  const pane = tabPanes[index];
  if (pane) dom.panes.scrollTo({ left: pane.offsetLeft - dom.panes.offsetLeft, behavior: 'smooth' });
}

tabButtons.forEach((button, i) => button.addEventListener('click', () => showTab(i)));
// A swipe moves the tabs rather than leaving them behind.
dom.panes.addEventListener('scroll', () => {
  const width = dom.panes.clientWidth || 1;
  showTab(Math.max(0, Math.min(TABS.length - 1, Math.round(dom.panes.scrollLeft / width))), false);
});
showTab(0, false);

/** The pictures on the buttons animate, slowly, whether or not anything else does. */
function paintIcons(now: number): void {
  for (const card of gameCards) paintIcon(card.pixel, card.game, now);
  for (const pick of gamePicks) paintIcon(pick.pixel, pick.game, now);
  paintIcon(musicPixel, music.muted ? 'muted' : 'music', now);
  paintIcon(leavePixel, 'leave', now);
}

/** The icon buttons in the bar carry a drawn glyph, not a letter. */
const musicPixel = document.createElement('canvas');
musicPixel.className = 'pixel';
dom.btnMusic.replaceChildren(musicPixel);
const leavePixel = document.createElement('canvas');
leavePixel.className = 'pixel';
dom.btnLeave.replaceChildren(leavePixel);

/** Where the session is up to, shown in the corner of a lit game's HUD. */
let sessionLabel = '';

/** The card between games: shown as a game is announced, gone when it is live. */
let introUntil = 0;
let introGame: GameChoice = 'deadlight';

function announceGame(msg: Extract<ServerMessage, { t: 'session' }>, now: number): void {
  const game: GameChoice = isMiniGameId(msg.next) ? msg.next : 'deadlight';
  introGame = game;
  introUntil = now + msg.startsInMs;
  dom.introName.textContent = game === 'deadlight' ? GAME_NAMES.deadlight : GAME_NAMES[game];
  dom.introRule.textContent = gameModeBlurb(msg.next);
  const parts: string[] = [];
  if (msg.runs > 1) parts.push(`RUN ${msg.run}/${msg.runs}`);
  if (msg.games > 1) parts.push(`GAME ${msg.game}/${msg.games}`);
  sessionLabel = parts.join('  ');
  if (lit) lit.label = sessionLabel;
  parts.push('LAST ONE STANDING');
  dom.introLabel.textContent = parts.join('  ·  ');
  dom.intro.hidden = false;
}

/** The menu picker shows what this player will ask for. */
function showWanted(): void {
  for (const card of gameCards) card.button.classList.toggle('mine', card.game === wanted);
  dom.gameBlurb.textContent =
    wanted === 'mix' ? 'A different game every round.' : gameModeBlurb(wanted === 'deadlight' ? 'classic' : wanted);
}


/** The Game pane: what the room is set to, and what the host may change. */
function showGame(msg: Extract<ServerMessage, { t: 'lobby' }>): void {
  const host = msg.host;
  const party = msg.code !== null;
  const seated = msg.players.length;
  // An older server says less about the room; fall back rather than break.
  const game: GameChoice = msg.game ?? (isMiniGameId(msg.gameMode) ? msg.gameMode : 'deadlight');
  const darkMode = msg.darkMode ?? (isMiniGameId(msg.gameMode) ? 'classic' : msg.gameMode);
  session = msg.session ?? session;
  wanted = game;

  const name = game === 'mix' ? 'Mix' : GAME_NAMES[game];
  dom.lobbyGame.textContent = party ? name : `Next: ${name}`;
  for (const pick of gamePicks) {
    pick.button.classList.toggle('mine', pick.game === game);
    pick.button.disabled = !host || !party;
  }
  for (const card of gameCards) card.button.classList.toggle('mine', card.game === game);

  // The dark game keeps its four modes; the lit ones have none.
  dom.modeSection.hidden = game !== 'deadlight';
  const short = seated < gameModeMinPlayers(game === 'deadlight' ? darkMode : (game as GameMode));
  dom.modeName.textContent = gameModeName(darkMode);
  dom.modeBlurb.textContent = short
    ? `Needs ${gameModeMinPlayers(darkMode)} fighters or more.`
    : gameModeBlurb(darkMode);
  dom.modeBlurb.classList.toggle('warn', short);
  for (const pick of modePicks) {
    pick.button.classList.toggle('mine', pick.mode === darkMode);
    pick.button.disabled = !host || !party;
  }

  // Runs always apply; the pool and the games-per-run only matter for a mix.
  dom.voteMix.hidden = game !== 'mix';
  dom.voteRunsTotal.textContent = `${session.runs}`;
  dom.voteCountTotal.textContent = `${session.count}`;
  for (const step of runSteps) {
    step.button.classList.toggle('mine', step.value === session.runs);
    step.button.disabled = !host || !party;
  }
  for (const step of countSteps) {
    step.button.classList.toggle('mine', step.value === session.count);
    step.button.disabled = !host || !party;
  }
  for (const pick of poolPicks) {
    pick.button.classList.toggle('mine', session.games.includes(pick.game));
    pick.button.disabled = !host || !party;
  }

  // A lit game ignores the arena, so the picker goes away with it.
  dom.mapSection.hidden = game !== 'deadlight' && game !== 'mix';
}

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
      // Back in the lobby: the dark game owns the screen again.
      endLit();
      scene.selfId = msg.selfId;
      countdownEndsAt = msg.countdownMs === null ? null : performance.now() + msg.countdownMs;
      ready = msg.players.find((p) => p.id === msg.selfId)?.ready ?? false;

      dom.lobbyTitle.textContent = msg.code ? 'Party' : 'Matchmaking';
      dom.lobbyCodeRow.hidden = !msg.code;
      dom.lobbyCode.textContent = msg.code ?? '';
      dom.lobbyCount.textContent = `${msg.players.length}/${MAX_PLAYERS}`;
      dom.btnStart.hidden = !msg.code || !msg.host;
      dom.btnStart.disabled = msg.players.length < Math.max(2, gameModeMinPlayers(msg.gameMode));
      showGame(msg);
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
          if (p.id !== msg.selfId) {
            if (msg.code && isHost) row.append(kickButton(p));
            else if (msg.votesNeeded !== null && !p.bot) {
              row.append(voteButton(p.id, msg.votes[p.id] ?? 0, msg.votesNeeded, msg.voted.includes(p.id)));
            }
          }
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
      if (isMiniGameId(msg.gameMode)) {
        startLit(msg.gameMode, msg.players);
        return;
      }
      endLit();
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
      scene.mode = msg.gameMode;
      scene.round = null;
      scene.brief = null;
      scene.cycle = 0;
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

    case 'session': {
      announceGame(msg, performance.now());
      return;
    }

    case 'mini': {
      if (!lit || lit.kind !== msg.kind) return;
      lit.round = msg.round;
      lit.left = msg.left;
      lit.players = msg.players;
      lit.scores = msg.scores;
      lit.extra = msg.extra;
      const me = msg.players.find((p) => p.id === lit!.selfId);
      // The server has the last word on where this fighter is; prediction only
      // fills the gap between states.
      lit.self = me && me.state === 'alive' ? { x: me.x, y: me.y, aim: lit.self?.aim ?? me.aim } : null;
      litVelocity = litVelocityOf(msg.extra, lit.selfId);
      return;
    }

    case 'lights': {
      const now = performance.now();
      const shrinking = scene.lights !== null && msg.size !== msg.previousSize;
      const entering =
        scene.mode === 'classic' && msg.remaining === 2 && !msg.replay && (lastRemaining > 2 || msg.round === 0);
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
      scene.self = me?.alive && !extracted() ? { x: me.x, y: me.y, aim: me.aim } : null;
      // Round modes bring everyone back each round, so this goes both ways.
      scene.spectating = scene.inMatch && !scene.self;

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
      // Anything gone that no beam broke was switched off: the sudden-death power cut.
      const cut = msg.broken.filter((id) => !before.broken.has(id) && !msg.resolution?.broken.includes(id));
      if (cut.length > 0) window.setTimeout(() => coverCut(cut), RESOLVE_DELAY_MS + HIT_STOP_MS + 150);
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

    case 'round':
      scene.round = { info: msg, at: performance.now() };
      if (!msg.outcome) scene.cycle = 0;
      return;

    case 'brief':
      scene.brief = msg.brief;
      // A finished or failed Assassin leaves the arena and watches the rest.
      if (extracted()) {
        scene.self = null;
        scene.spectating = true;
      }
      return;

    case 'dark': {
      scene.phase = 'dark';
      if (scene.mode !== 'classic') scene.cycle++;
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

      // Classic and the lit games are won by surviving; the round modes by points.
      const scored = msg.gameMode !== 'classic' && !isMiniGameId(msg.gameMode);
      const modeName = gameModeName(msg.gameMode);
      dom.resultTitle.textContent = won ? 'Victory' : !champion ? 'Draw' : scored ? 'Defeat' : 'Eliminated';
      dom.resultTitle.className = won ? 'victory' : champion ? '' : 'draw';
      dom.resultDetail.textContent = scored
        ? won
          ? `Top score in ${modeName} after ${msg.rounds} rounds`
          : champion
            ? `${champion.name} wins ${modeName}`
            : `Tied at the top after ${msg.rounds} rounds`
        : won
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

          const status = standing.id === msg.winner ? 'Won' : scored ? '' : `R${String(standing.roundsSurvived).padStart(2, '0')}`;
          const stat = scored
            ? `${standing.score ?? 0} PTS \u00b7 ${standing.kills}K`
            : `${standing.kills}K \u00b7 ${msg.wins[standing.id] ?? 0}W`;

          row.append(
            swatch(fighter ? `#${fighter.color.toString(16).padStart(6, '0')}` : '#ccd6e2'),
            document.createTextNode(`${i + 1}. ${fighter?.name ?? '???'}`),
            label(scored ? 'stat score' : 'stat', stat),
            label('tag', status),
          );
          return row;
        }),
      );

      const more = msg.sessionLeft ?? 0;
      dom.btnAgain.hidden = more > 0;
      if (more > 0) {
        dom.resultDetail.textContent = `${more} ${more === 1 ? 'game' : 'games'} left in the session`;
      }

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

    case 'kicked':
      scene.inMatch = false;
      scene.killcam = null;
      music.stop();
      show('menu');
      dom.menuError.textContent = msg.vote ? 'The others voted you out.' : 'The host removed you from the party.';
      return;

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

/** Hand the screen to a lit game. */
function startLit(kind: Parameters<typeof litRenderer.configure>[0], players: readonly LobbyPlayer[]): void {
  lit = {
    kind,
    round: 0,
    left: 0,
    players: [],
    scores: {},
    extra: emptyExtra(kind),
    selfId: scene.selfId,
    label: sessionLabel,
    roster: new Map(
      players.map((p) => [p.id, { color: rgb(p.color), name: p.name, archetype: archetypeOf(p.color) }]),
    ),
    self: null,
  };
  // The result card and its standings read the match roster, whichever game it was.
  scene.roster = new Map(
    players.map((p) => [
      p.id,
      { name: p.name, color: rgb(p.color), archetype: archetypeOf(p.color), finisher: p.finisher },
    ]),
  );
  litVelocity = null;
  scene.inMatch = true;
  scene.spectating = false;
  countdownEndsAt = null;
  clearTimeout(resultTimer);
  resultPending = false;
  litRenderer.configure(kind);
  stage.hidden = true;
  litStage.hidden = false;
  music.setShowdown(false);
  music.start();
  show(null);
}

/** Give it back to the dark game. */
function endLit(): void {
  if (!lit) return;
  lit = null;
  litVelocity = null;
  litStage.hidden = true;
  stage.hidden = false;
}

/** A floor with nothing on it yet, until the first state arrives. */
function emptyExtra(kind: MiniScene['kind']): MiniScene['extra'] {
  switch (kind) {
    case 'freeze':
      return { kind, light: 'green', phaseLeft: 0, zaps: [] };
    case 'collapse':
      return { kind, tiles: solidFloor(), edge: 0, falls: [], broke: [], dashing: [] };
    case 'rooms':
      return {
        kind,
        phase: 'music',
        phaseLeft: 0,
        target: null,
        rooms: Array.from({ length: ROOM_COUNT }, () => ({ open: true, locked: false, outcome: null })),
      };
    case 'sumo':
      return {
        kind,
        floe: freshFloe(),
        cracking: [],
        vel: {},
        charging: {},
        cooldowns: {},
        hits: [],
        shoves: [],
        bounces: [],
        falls: [],
        dashing: [],
      };
    case 'potato':
      return { kind, holders: [], heat: [], passes: [], booms: [], cooldowns: {}, dashing: [] };
  }
}

/** The momentum the server last reported for this fighter, if the game has any. */
function litVelocityOf(extra: MiniScene['extra'], id: string): { x: number; y: number } | null {
  if (extra.kind !== 'sumo') return null;
  const v = extra.vel[id];
  return v ? { x: v[0], y: v[1] } : null;
}

/**
 * Where this fighter is between server states. Every game predicts with the
 * same step the server runs, so the fighter answers the key immediately and
 * still ends up where the server says it is.
 */
function predictLit(dt: number, dir: { x: number; y: number }): void {
  const at = lit?.self;
  if (!lit || !at) return;
  switch (lit.extra.kind) {
    case 'freeze': {
      const next = stepFreeze(at, dir.x, dir.y, dt);
      at.x = next.x;
      at.y = next.y;
      return;
    }
    case 'collapse': {
      const next = stepCollapse(at, dir.x, dir.y, dt, MOVE_SPEED);
      at.x = next.x;
      at.y = next.y;
      return;
    }
    case 'rooms': {
      const next = stepRooms(at, dir.x, dir.y, dt, lit.extra);
      at.x = next.x;
      at.y = next.y;
      return;
    }
    case 'potato': {
      const next = stepPotato(at, dir.x, dir.y, dt, lit.extra.holders.includes(lit.selfId));
      at.x = next.x;
      at.y = next.y;
      return;
    }
    case 'sumo': {
      // Ice is momentum, not input: carry the last reported velocity forward.
      if (!litVelocity) return;
      at.x += litVelocity.x * dt;
      at.y += litVelocity.y * dt;
      return;
    }
  }
}

/** One frame of a lit game: steer, predict, draw. */
function litFrame(now: number, dt: number): void {
  if (!lit) return;
  const dir = input.direction();
  predictLit(dt, dir);
  if (lit.self) {
    const target = litRenderer.worldFromScreen(input.pointer.x, input.pointer.y);
    lit.self.aim = Math.atan2(target.y - lit.self.y, target.x - lit.self.x);
  }
  litRenderer.frame(lit, now);
}

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

function coverCut(ids: readonly string[]): void {
  const now = performance.now();
  for (const id of ids) {
    const crate = scene.world.layout.obstacles.find((o) => o.id === id);
    if (crate?.kind === 'crate') renderer.crateBroken(crate, now);
  }
  renderer.announce('NO COVER!', null, now);
  sfx.alarm();
  buzz([60, 40, 60]);
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

/** Party host: removes a bot, or kicks a person. */
function kickButton(player: LobbyPlayer): HTMLElement {
  const button = document.createElement('button');
  button.className = 'kick';
  button.textContent = '\u00d7';
  button.title = player.bot ? 'Remove bot' : `Kick ${player.name}`;
  button.addEventListener('click', () =>
    net.send(player.bot ? { t: 'bot', add: false, id: player.id } : { t: 'kick', id: player.id }),
  );
  return button;
}

/** Matchmaking: a vote to remove someone, with the running tally. Click again to take it back. */
function voteButton(id: string, votes: number, needed: number, mine: boolean): HTMLElement {
  const button = document.createElement('button');
  button.className = mine ? 'vote mine' : 'vote';
  button.textContent = votes > 0 ? `Kick ${votes}/${needed}` : 'Kick';
  button.title = mine ? 'Take back your vote' : `Vote to kick (${needed} votes needed)`;
  button.addEventListener('click', () => net.send({ t: 'kick', id }));
  return button;
}

function label(className: string, text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** An Assassin whose contract is finished, either way, is out of the round. */
function extracted(): boolean {
  return scene.mode === 'assassin' && scene.brief !== null && scene.brief.status !== 'live';
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
let lastIcons = 0;

function loop(now: number): void {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  if (now - lastIcons > 120) {
    lastIcons = now;
    paintIcons(now);
  }
  if (!dom.intro.hidden) {
    paintIcon(dom.introIcon, introGame, now);
    if (now >= introUntil) dom.intro.hidden = true;
  }

  if (lit) {
    litFrame(now, dt);
    requestAnimationFrame(loop);
    return;
  }

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
      const free = stepPlayer(scene.self, dir.x, dir.y, dt, scene.world);
      const path = scene.brief?.role === 'target' ? scene.brief.path?.legs : undefined;
      const moved = path ? onPath(free, path) : free;
      const jump = path ? { ...moved, onPad, jumped: false } : teleportStep(moved, scene.world, onPad);
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
  if (lit) {
    const at = lit.self;
    if (!at) return;
    const dir = input.direction();
    net.send({
      t: 'input',
      seq: prediction.record(at.x, at.y),
      mx: dir.x,
      my: dir.y,
      aim: at.aim,
      action: input.takeAction(),
    });
    return;
  }
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
  // A party opens on the game picked from the menu; matchmaking sets its own.
  if (mode === 'create' && wanted !== 'deadlight') net.send({ t: 'mode', mode: wanted });
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

wake();
showFinisher();
showWanted();
showMusic();
show('menu');
requestAnimationFrame(loop);
