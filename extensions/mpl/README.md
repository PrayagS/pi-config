# mpl

Codemode-only `mpl_render` tool that draws matplotlib-style charts with [`mpl`](https://github.com/ivarvong/mpl) (a pure-TypeScript port of matplotlib's output) from a JSON call list, writes PNG/SVG, and returns the PNG so a codemode script can show it with `image(r.image)`.

Upstream: copied from [dmmulroy/.dotfiles `home/.pi/agent/extensions/mpl`](https://github.com/dmmulroy/.dotfiles/tree/main/home/.pi/agent/extensions/mpl) at commit `62bda01e`. That repository declares no license; clarify reuse terms before publishing.

## Usage

The tool has `exposure: "codemode"` and namespace `mpl`, so the model reaches it only through the `codemode` tool:

```js
const help = await describeNamespace("mpl")
const r = await tools.mpl_render({
  name: "latency",
  calls: [
    [
      "plot",
      [
        [1, 2, 3],
        [120, 95, 140],
      ],
      { label: "p50" },
    ],
    ["set_title", ["Latency"]],
    ["legend", []],
  ],
})
image(r.image)
```

- Calls are `[method, [positional args], {kwargs}]`, applied to the current Axes; `fig.*` calls target the Figure.
- Method names are checked against an allow-list built from `Axes.prototype` (public, non-private names) plus a fixed set of Figure methods.
- Each render runs in a fresh worker thread (`worker.ts`). pi stays responsive during the render, aborting the tool call terminates it, and renders are stopped after 30 s. `mpl` loads only inside the worker, so it adds nothing to pi's startup.
- Limits (`limits.ts`), checked before rendering: at most 64 Axes per grid and 1,000,000 values per spec.
- Themes: a spec without `theme` follows pi's appearance (`ctx.ui.theme.appearance`): `gruvbox-dark` or `gruvbox-light`. Without a UI it uses `gruvbox-dark`. Both are in `styles/`. Also available: mpl's bundled styles (`pro-slate`, `pro-dark`, `ggplot`, ...). Neither matplotlib nor mpl ships Gruvbox. The two styles use [morhetz/gruvbox](https://github.com/morhetz/gruvbox)'s palette (MIT/X11): bright accents on dark, faded accents on light. C0..C6 are blue, orange, green, red, purple, aqua and yellow in both themes.
- Output: `~/.pi/agent/work/charts/<YYYY-MM-DD>/<name>-<HHMMSSmmm>.{png,svg}`, in local time. Files are never cleaned up (by choice); delete old dated folders by hand.

## Charts in the final answer (spike)

The model can only write text, so `image(r.image)` shows a chart only inside the collapsed codemode tool call. To show it to the user, the instructions tell the agent to cite the final chart in its answer as `![title](<pngPath>)` on its own line. `display.ts` then draws it in one of two ways; switch with `/mpl-display inline|entry|off` (in memory, per pi process) or set `PI_MPL_CHART_DISPLAY`. The default is `inline`.

- `inline` (default): a Markdown transformer on finished assistant messages replaces the citation with a Kitty graphics sequence and invisible hard-break rows that reserve its height, so the chart is drawn where it is cited. It is also applied when you reopen a session, as long as the file exists. It relies on pi's Markdown passing image escape sequences through, which is not documented, and works only on Kitty-protocol terminals; elsewhere the citation shows as its title.
- `entry`: when the run settles, each chart the final answer cites is appended as a TUI-only custom entry (`pi.appendEntry` + `registerEntryRenderer`, drawn with pi-tui's `Image`). It appears just below the answer, persists in the session and is never sent to the model. Aborted runs append nothing.

Both modes show only absolute PNG paths under `~/.pi/agent/work/charts`, once per path. Without either mode, pi's Markdown renders the citation as its alt text.

## Requirements

- Node >= 24 (an `mpl` engine constraint).
- `mpl` is not on npm. It is a git dependency pinned to a full commit SHA in the root `package.json`, and its `prepare` script builds `dist/` on install. Package managers gate both steps, so the repo allow-lists them:
  - npm 12 refuses git dependencies by default (`EALLOWGIT`): `.npmrc` sets `allow-git=root`. npm also warns about the unapproved `prepare` script: `allowScripts` in `package.json` approves that exact commit.
  - pnpm fails on the build (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`): `pnpm-workspace.yaml` lists the commit under `allowBuilds`.
  - bun is not supported. It runs the TypeScript build script from inside `node_modules`, which Node refuses (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), even with `trustedDependencies`.
- When bumping `mpl`, update the SHA in all three places: `dependencies`, `allowScripts`, and `pnpm-workspace.yaml`.

## Tests

```bash
npm run test:mpl
```

`@earendil-works/pi-tui` is a dev dependency, pinned to the pi version, for the display tests only. Inside pi, the extension loader aliases it to pi's own copy.
