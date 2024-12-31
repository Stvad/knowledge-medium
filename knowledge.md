# Omniliner Project Knowledge

## Project Overview
A Workflowy-like editor with dynamic block rendering capabilities. Blocks can contain custom renderers that are compiled and executed at runtime.

## Dependency management
- `yarn` is used for package management

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

### Document Initialization
- Initialize new documents with empty arrays for collections
- Use useEffect for setting initial data
- Check both undefined and empty states when initializing
- Avoid direct object assignment in changeDoc

### Collaboration Features
- Share documents via URL with ?docId parameter
- Real-time updates across connected clients
- Offline support with IndexedDB
- Automatic state sync when reconnecting

## Key Patterns

### Block Properties
- `type: 'renderer'` - Block contains component code
- `renderer: '<block-id>'` - Use renderer defined in referenced block
- Properties are editable through BlockProperties component

### Error Handling
- All dynamic components are wrapped in error boundaries
- Compilation errors display inline error messages
- Failed renderers fallback to error display component

## Development Guidelines

### State Management
- Prefer explicit state updates over automatic effects when dealing with complex state
- Use manual refresh functions instead of useEffect for registry-like state that depends on complex objects

### Adding New Features
- Keep block operations immutable
- Wrap dynamic code execution in error boundaries
- Update through Automerge for CRDT support

### Testing
- Test dynamic components with various content
- Verify error cases show appropriate messages
- Check block operations maintain tree structure

## Features

### Safe Mode
- Add `?safeMode` to URL to disable dynamic renderer loading
- Only default renderers will be used
- Useful for debugging or when custom renderers are problematic

## Common Tasks

### Creating a Custom Renderer
```typescript
export default function CustomRenderer({ block, onUpdate }) {
    return <div>Custom content for: {block.content}</div>
}
```

### Using a Custom Renderer
1. Create block with `type: 'renderer'`
2. Add renderer code to block content
3. Reference renderer in other blocks with `renderer: '<block-id>'`

## Dependencies
- @babel/standalone - Runtime TypeScript/React compilation
- @automerge/automerge - CRDT for block storage
- react-error-boundary - Component error handling
