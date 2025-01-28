# Omniliner Project Knowledge

## Project Overview
A Workflowy-like editor with dynamic block rendering capabilities. Blocks can contain custom renderers that are compiled and executed at runtime.

## Dependency management
- `yarn` is used for package management
- Run `yarn tsc -b` to type check the project (uses TypeScript's build mode with project references)

## Architecture

### Block System
- Each block has unique ID, content, properties, and children
- Blocks can be nested arbitrarily deep
- Properties control block behavior and rendering
- Special 'renderer' type blocks define custom rendering components

### Dynamic Component System
- Uses Babel to compile TypeScript/React code at runtime
- Components are wrapped with error boundaries for safety
- Custom renderers can access and modify their block's content

### Data Storage
- Uses automerge-repo with React hooks for CRDT-based storage
- Persistent storage in IndexedDB
- Real-time collaboration via wss://sync.automerge.org
- Document sharing through URL hash parameters
- Automatic conflict resolution
- Uses RepoContext for repo access throughout app

## Key Patterns

### Block Properties
- `type: 'renderer'` - Block contains component code
- `renderer: '<block-id>'` - Use renderer defined in referenced block
- Properties are editable through BlockProperties component

## Development Guidelines

### State Management
- Prefer explicit state updates over automatic effects when dealing with complex state
- Use manual refresh functions instead of useEffect for registry-like state that depends on complex objects

### Adding New Features
## Features

### Safe Mode
- Add `?safeMode` to URL to disable dynamic renderer loading
- Only default renderers will be used
- Useful for debugging or when custom renderers are problematic

