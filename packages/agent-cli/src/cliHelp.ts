// How `kmagent` help reads. cac prints every command's description in the
// top-level list and none under the command's own `--help`; this inverts it.
// The list gives each command its summary, the first sentence of its
// description, and `<command> --help` opens with the whole description.

/** cac's help section; cac does not export the type. */
interface HelpSection {
  title?: string
  body: string
}

interface HelpCommand {
  rawName: string
  description: string
}

/** A description's first sentence. It is the command's line in the
 *  top-level list, so it must read on its own. */
export const commandSummary = (description: string): string =>
  description.split(/(?<=[.!?])\s+(?=[A-Z`(])/, 1)[0]

const COMMANDS_TITLE = 'Commands'
const MORE_INFO_TITLE = 'For more info, run any command with the `--help` flag'

export const helpSections = (
  sections: readonly HelpSection[],
  {bin, commands, matched}: {bin: string, commands: readonly HelpCommand[], matched: HelpCommand | undefined},
): HelpSection[] => {
  if (matched) {
    const usage = sections.findIndex(section => section.title === 'Usage')
    return [...sections.slice(0, usage + 1), {body: matched.description}, ...sections.slice(usage + 1)]
  }
  const width = Math.max(...commands.map(command => command.rawName.length))
  return sections.map(section => {
    if (section.title === COMMANDS_TITLE) {
      return {
        title: COMMANDS_TITLE,
        body: commands.map(command => `  ${command.rawName.padEnd(width)}  ${commandSummary(command.description)}`).join('\n'),
      }
    }
    if (section.title === MORE_INFO_TITLE) {
      return {body: `Run \`${bin} <command> --help\` for a command's full description and its options.`}
    }
    return section
  })
}
