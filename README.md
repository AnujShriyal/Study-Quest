# Study Quest

A lightweight Windows desktop app to track daily study time, gamified like a game
launcher (XP, levels, streaks), with a todo list ("Quest Log") and a small
always-on-top floating timer overlay.

## Features

- **Session timer** — start/pause/stop, tag each session with a subject.
- **XP & Levels** — every 25 minutes studied earns XP; level up as you go.
- **Streaks** — tracks consecutive days studied (current + longest).
- **Todo list (Quest Log)** — add, check off, delete tasks. Mirrored in the overlay.
- **Session history** — a log of past sessions with subject + duration.
- **Floating overlay** — small, frameless, always-on-top widget with the timer
  and a mini todo list. Drag it anywhere; it remembers its position.
- **System tray icon** — left-click toggles the overlay, right-click gives a
  menu (show dashboard, toggle overlay, quick-start timer, quit). Closing the
  dashboard window minimizes it to the tray instead of quitting.
- All data is stored locally in a JSON file (no account, no internet needed).

## 1. Install prerequisites

You need [Node.js](https://nodejs.org) (LTS version). Download and install it,
then confirm in a terminal (PowerShell / cmd):

```
node -v
npm -v
```

## 2. Install dependencies

Open a terminal in the `study-tracker` folder and run:

```
npm install
```

This downloads Electron and electron-builder (only needed once).

## 3. Run it in development mode

```
npm start
```

The dashboard window opens, the overlay appears near the top-right of your
screen, and a tray icon shows up in the bottom-right of your taskbar (you may
need to click the little "^" arrow on the taskbar to see it, then drag it out
if you want it always visible).

## 4. Build a real installer (.exe) with a desktop shortcut

```
npm run dist
```

This produces a Windows installer inside the `dist` folder (something like
`Study Quest Setup 1.0.0.exe`). Run that installer:

- It will ask where to install and will **create a Desktop shortcut and a
  Start Menu shortcut automatically** (this is configured already in
  `package.json`).
- Windows SmartScreen may warn you because the installer isn't code-signed —
  click **"More info" → "Run anyway"**. This is normal for personal/unsigned
  apps and safe since you built it yourself.

## 5. Pin it to the taskbar

After installing and launching Study Quest from the Desktop shortcut or Start
Menu:

1. Right-click its icon on the taskbar while it's running.
2. Choose **"Pin to taskbar"**.

Windows doesn't allow apps to do this pinning step for you programmatically —
it's a one-click manual step, same as any other Windows app.

## 6. The tray icon (bottom-right of the taskbar)

Once running, Study Quest also lives in the system tray (the small icons area
near the clock). Click the little **^** (show hidden icons) arrow if you don't
see it, then optionally drag the icon out to keep it always visible.

## Project structure

```
study-tracker/
  main.js              Electron main process: windows, tray, timer engine, data
  preload.js            Secure bridge exposing window.api to the UI
  renderer/
    dashboard.html/css/js   Main window (stats, session control, todos, history)
    overlay.html/css/js     Floating always-on-top widget
    theme.css               Shared color/type tokens
  assets/
    icon.ico             App/installer icon
    tray.png              Tray icon
  package.json
```

## Notes / things you can tweak

- **XP rate**: edit `xpForSeconds()` in `main.js` (currently ~100 XP per 25
  minutes).
- **Level curve**: edit `levelFromXp()` in `main.js`.
- **Overlay size/position**: edit `createOverlayWindow()` in `main.js`, or just
  drag it once running — position is remembered automatically.
- **Data file location**: `%APPDATA%\study-quest\study-quest-data.json` on
  Windows. Delete it to reset all progress.
