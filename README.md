# DeadLight

A small multiplayer arena game played in the dark.

The lights come on and you see everyone. Then they go out, and for a few seconds
you can only see yourself and your own laser. Everyone moves blind, aiming at
where they think someone else went. When the lights return, every beam fires at
once.

**Play it:** [deadlight.onrender.com](https://deadlight.onrender.com) — create a
party, send the four-letter code to your friends, ready up.

![The arena with the lights on](docs/arena.jpg)

## How to play

- Up to ten players. Pick one of ten fighters in the lobby. Each colour can only be taken by one player.
- **WASD** to move, **mouse** to aim. On a phone, your left thumb is a joystick
  and touching the right half aims. You can only move while the lights are off.
- A laser hits **every** player it crosses.
- If two players hit each other, both shots cancel and both survive.
- The arena shrinks through five stages as players die, or by itself if nobody
  dies for three rounds. The coloured floor bands show where it will close next.
- Last one standing wins.

In a party, the host adds and removes bots and can kick players. Public
matchmaking is people only; a player is removed if most of the others vote to
kick them.

## Games

Six games, picked on the menu or in the lobby's Game tab: DeadLight and the
five lit ones. **Mix** plays a different one each round, and a session can run
several games through several runs. Public matchmaking plays the DeadLight
modes in turn; the lit games are a party pick.

### DeadLight — played in the dark

- **Classic** — the rules above. Last one standing wins.
- **Hunted** — each round one player is the Target, held to a secret path (a line,
  L, T, Z, zigzag or square). Everyone else hunts them. Catch the Target: +1 to
  whoever hit it. Survive three blackouts: +1 to the Target, who can shoot back.
- **Ghost** — each round one player is the Ghost: unarmed, free to roam, and
  invisible to the hunters after the round's first reveal. Find it: +1. Stay
  hidden: +1 to the Ghost.
- **Assassin** — everyone gets a secret target. Kill yours, or any three
  others, to complete your contract (+1) and leave the arena. Die first and the
  contract fails. Three players minimum.

Every player takes the same number of turns as Target or Ghost, and the
highest score wins. The server deals all roles and contracts and decides every
point; each player is only sent their own.

### The lit games

No lasers and no blackout: the floor is lit, everyone can see everyone, and the
arena is what takes you out. **WASD** to move, and one action button —
**space**, **shift** or **J**, or a tap on the right half of a phone screen.
Last one standing wins.

- **Freeze** — a long corridor with an eye at the far end. Run while it is
  turned away; move while it looks and you are gone. Last one over the line each
  race is out.
- **Collapse** — an eleven by eleven floor that breaks from the outside in.
  Tiles crack, then shake, then are not there. Dash with the action button, and
  remember the middle goes last.
- **Rooms** — eight side rooms off a floor that spins to the music. A number is
  called, the clock runs, and the doors lock: a room saves the fighters inside it
  only if exactly that many got in. The dance floor saves nobody. Three minimum.
- **Sumo** — a disc of ice that keeps cracking back in wedges. No weapons, just
  momentum: the action button dashes, and a dash that lands sends someone
  skating. Off the ice is out.
- **Potato** — a live bomb, a short fuse, and pillars to lose people behind.
  Touch someone to hand it over; hands stay too hot to take it back for a
  moment. Holding it at the bang is out. Three minimum.

![A blackout: only your own fighter and laser are visible](docs/blackout.jpg)

## Running locally

```sh
npm install
npm run dev        # client on :5173, server on :8080
```

Production build, served from one process:

```sh
npm run build
npm start
```

`render.yaml` deploys it to Render as a single web service.

The client can also go on Firebase Hosting, talking to that server:
`npm run deploy:firebase` (the server URL is in `.env.firebase`).

## How it works

- **TypeScript** everywhere. A Node server using `ws`, a Canvas 2D client, and a
  `shared/` folder for the rules both sides use.
- **The server is authoritative.** It moves every player and resolves each round
  from a single snapshot taken the moment the lights come back. The lit games run
  the same way: the server owns the floor, the fuse and the ice, and the client
  predicts only its own fighter — with the same step function the server uses.
- **No wallhacks by design.** During a blackout a living player is only ever
  sent their own position, so there is nothing about opponents to read.
- **Pixel art without assets.** The game draws into its own pixel buffer and
  scales it up, so everything stays sharp. Characters and the HUD font are
  written as text grids in the code — no image files.

## Tests

```sh
npm test
```

Covers hit detection, movement, arena geometry, stage progression, latency
handling, the five lit games' floors and physics, and a full match of each game
run through the server.
