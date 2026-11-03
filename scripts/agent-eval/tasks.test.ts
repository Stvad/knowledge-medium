import { describe, expect, it } from 'vitest'
import { buildFixture } from './fixture'
import { taskDefinitionHash, TASKS } from './tasks'

describe('taskDefinitionHash', () => {
  const {truth} = buildFixture()
  const task = TASKS.find(candidate => candidate.id === 'summarize-design')!

  it('changes when a value the check closes over changes, though its source text does not', () => {
    const looser = {...truth, design: {...truth.design, adopted: /\blww\b|merge/i}}
    expect(taskDefinitionHash(task, looser)).not.toBe(taskDefinitionHash(task, truth))
  })
})
