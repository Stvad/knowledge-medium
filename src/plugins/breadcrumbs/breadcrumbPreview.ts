export const getBreadcrumbContentPreview = (content: string) =>
  content.match(/^[^\r\n]*/)?.[0] ?? ''
