import { firstLine } from '@/utils/string.js'

export const getBreadcrumbContentPreview = (content: string) => firstLine(content)
