export const openLeftSidebarEvent = 'left-sidebar:open'
export const closeLeftSidebarEvent = 'left-sidebar:close'
export const toggleLeftSidebarEvent = 'left-sidebar:toggle'

export const openLeftSidebar = (): void => {
  window.dispatchEvent(new CustomEvent(openLeftSidebarEvent))
}

export const closeLeftSidebar = (): void => {
  window.dispatchEvent(new CustomEvent(closeLeftSidebarEvent))
}

export const toggleLeftSidebar = (): void => {
  window.dispatchEvent(new CustomEvent(toggleLeftSidebarEvent))
}
