import type {MarginCard} from './placement.ts'

interface AnchorLinkGroup {
  row: number
  trailing: boolean
  sourceY: number
  cardYs: number[]
  selected?: {sourceY: number; cardY: number}
}

const LINK_Y_IN_CARD = 10

/** Cards are in row order. A stub stands for threads on other blocks and
 *  has its own connector even when its host also has threads. */
export const anchorLinkGroups = (
  placed: readonly (Pick<MarginCard, 'row' | 'anchor' | 'trailing'> & {key: string})[],
  tops: readonly number[],
  selectedKey: string | undefined,
): AnchorLinkGroup[] => {
  const groups: AnchorLinkGroup[] = []
  for (const [i, {key, row, anchor, trailing}] of placed.entries()) {
    const sourceY = Math.round(anchor) + LINK_Y_IN_CARD
    const cardY = Math.round(tops[i]) + LINK_Y_IN_CARD
    let group = groups.at(-1)
    if (group?.row !== row || group.trailing !== trailing) {
      group = {row, trailing, sourceY, cardYs: []}
      groups.push(group)
    }
    group.cardYs.push(cardY)
    if (key === selectedKey) group.selected = {sourceY, cardY}
  }
  return groups
}

/** Separate the gutter’s leader and rail tracks so a leader stays clear of
 *  the other blocks’ rails. */
export const MarginAnchorLinks = ({groups, width}: {groups: readonly AnchorLinkGroup[]; width: number}) => {
  const railX = width / 2
  const sourceX = 2
  const height = groups.reduce((max, {sourceY, cardYs}) =>
    Math.max(max, sourceY + sourceX, cardYs[cardYs.length - 1] + 2), 0)
  const selected = groups.find(group => group.selected)?.selected
  return (
    <svg
      className="pointer-events-none absolute top-0 text-amber-600/55 dark:text-amber-400/60"
      style={{left: -width}}
      width={width}
      height={height}
      aria-hidden
      data-margin-anchor-links
    >
      {groups.map(({row, trailing, sourceY, cardYs}) => {
        const leader = `M ${sourceX} ${sourceY} L ${railX} ${cardYs[0]}`
        const rail = `M ${railX} ${cardYs[0]} V ${cardYs[cardYs.length - 1]}`
        const branches = cardYs.map(y => `M ${railX} ${y} H ${width}`)
        const shared = cardYs.length > 1
        return (
          <g key={`${row}:${trailing}`} data-margin-anchor-group={row}>
            <path d={leader} fill="none" stroke="currentColor"/>
            <path
              d={[rail, ...branches].join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth={shared ? 2 : 1}
              className={shared ? 'text-amber-600/80 dark:text-amber-400/85' : undefined}
            />
            <circle cx={sourceX} cy={sourceY} r={sourceX} fill="currentColor"/>
          </g>
        )
      })}
      {selected && (
        <g className="text-amber-700 dark:text-amber-300" data-margin-selected-anchor>
          <path
            d={`M ${sourceX} ${selected.sourceY} L ${railX} ${selected.cardY} H ${width}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
          />
          <circle cx={sourceX} cy={selected.sourceY} r={sourceX} fill="currentColor"/>
        </g>
      )}
    </svg>
  )
}
