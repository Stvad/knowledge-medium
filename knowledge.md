# Omniliner Project Knowledge

## Project Overview
A Workflowy-like editor with dynamic block rendering capabilities. Blocks can contain custom renderers that are compiled and executed at runtime.

## Dependency management
- `yarn` is used for package management
- Run `yarn tsc -b` to type check the project (uses TypeScript's build mode with project references)

## Architecture

### Components structure 
In as much as possible we're pushing logic down to renderer components 
and keeping basic setup as minimal as possible. 
So anything that can be done in a renderer should be done there.
See LayoutBlockRenderer for an example of general page setup, CommandPalette setup, etc
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


### Keyboard Shortcut System
- Context-aware shortcuts (normal mode, edit mode, global, etc.)
- Uses hotkeys-js for keyboard event handling
- React hooks for activating/deactivating shortcut contexts
- User-configurable shortcuts stored in Automerge documents
- Priority system to handle context conflicts
- Actions and bindings are registered idempotently - duplicate registrations are ignored
- Multiple different key bindings can be registered for the same action

## Key Patterns

### Block Properties
- `type: 'renderer'` - Block contains component code
- `renderer: '<block-id>'` - Use renderer defined in referenced block
- Properties are editable through BlockProperties component

## State Management Principles

### Core Principle
The core principle of the system is to store all state within the system itself, using Automerge documents. This includes:
- UI state
- User preferences
- Keyboard shortcuts
- Block properties and relationships
- etc
Prefer to use block properties and sub-blocks to "unpack state" instead of storing a JSON objects

#### Exceptions
Credentials and sensitive information should not be stored in the document state, as they may be shared. These include:
- API keys (like OpenRouter API keys)
- Authentication tokens

### Configuration UI
Configuration UIs should be implemented as custom renderers for configuration blocks. This pattern is used for:
- OpenRouter settings
- Keyboard shortcut configuration
- Other user preferences

See RendererBlockRenderer for an example of a renderer


## Development Guidelines

### Responsive Design
- Mobile-first approach with Tailwind CSS breakpoints
- Key breakpoints: sm (640px), md (768px), lg (1024px)
- Stacked layouts on mobile, horizontal layouts on desktop
- Reduced font sizes and spacing on mobile devices

### Adding New Features
## Features
