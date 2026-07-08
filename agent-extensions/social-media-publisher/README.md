# Social Media Publisher Extension

This extension owns its platform SDK dependencies locally so they can be bundled into the installable agent-extension artifact without adding them to the main app dependency graph.

From a fresh checkout:

```sh
yarn
yarn --cwd agent-extensions/social-media-publisher install
yarn --cwd agent-extensions/social-media-publisher run check
```

The installable artifact is built at `agent-extensions/social-media-publisher/dist/index.js`. The `dist/` directory is generated and intentionally not committed.

To install the bundled version into a live agent profile:

```sh
yarn agent --profile chrome-t2 install-extension --verify agent-extensions/social-media-publisher/dist/index.js "Social Media Publisher"
yarn agent --profile chrome-t2 enable-extension "Social Media Publisher"
```
