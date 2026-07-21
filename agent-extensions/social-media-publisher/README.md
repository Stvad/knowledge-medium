# Social Media Publisher Extension

This extension owns its platform SDK dependencies locally so they can be bundled into the installable agent-extension artifact without adding them to the main app dependency graph.

From a fresh checkout:

```sh
pnpm install
pnpm -C agent-extensions/social-media-publisher install
pnpm -C agent-extensions/social-media-publisher run check
```

The installable artifact is built at `agent-extensions/social-media-publisher/dist/Social Media Publisher.js`. The `dist/` directory is generated and intentionally not committed. The agent CLI uses the file basename as the extension's install identity, so keep this filename when updating an existing installation.

To install the bundled version into a live agent profile:

```sh
pnpm agent --profile chrome-t2 install-extension --verify "agent-extensions/social-media-publisher/dist/Social Media Publisher.js"
pnpm agent --profile chrome-t2 enable-extension "Social Media Publisher"
```
