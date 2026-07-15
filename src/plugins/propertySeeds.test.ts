// @vitest-environment jsdom
import {describe, expect, it} from 'vitest'
import type {RefCodec, RefLikeCodec} from '@/data/api'
import {
  definitionSeedsFacet,
  valuePresetCoresFacet,
} from '@/data/facets'
import type {AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import {resolveFacetRuntimeSync, type AppExtension} from '@/facets/facet'
import {attachmentsPlugin} from '@/plugins/attachments'
import {
  MEDIA_PROPERTY_SCHEMAS,
} from '@/plugins/attachments/mediaBlock'
import {backlinksDataExtension} from '@/plugins/backlinks/dataExtension'
import {
  dailyNoteBacklinksDefaultsProp,
} from '@/plugins/backlinks/dailyNoteDefaults'
import {
  backlinksFilterPresetCore,
  backlinksFilterProp,
} from '@/plugins/backlinks/filterProperty'
import {backlinksViewPlugin} from '@/plugins/backlinks-view'
import {backlinksViewProp} from '@/plugins/backlinks-view/prop'
import {blockTaggingDataExtension} from '@/plugins/block-tagging/dataExtension'
import {
  blockTagsConfigPresetCore,
  blockTagsConfigProp,
} from '@/plugins/block-tagging/config'
import {characterCounterDataExtension} from '@/plugins/character-counter/dataExtension'
import {
  charLimitProp,
  charProfileProp,
  charScopeProp,
} from '@/plugins/character-counter/properties'
import {dailyNotesDataExtension} from '@/plugins/daily-notes/dataExtension'
import {dailyNoteDateProp} from '@/plugins/daily-notes/schema'
import {extensionsDataExtension} from '@/plugins/extensions-settings/dataExtension'
import {
  extensionsOverridesPresetCore,
  extensionsOverridesProp,
} from '@/plugins/extensions-settings/config'
import {geoDataExtension} from '@/plugins/geo/dataExtension'
import {GEO_PROPERTY_SCHEMAS, locationProp} from '@/plugins/geo/properties'
import {groupedBacklinksDataExtension} from '@/plugins/grouped-backlinks/dataExtension'
import {
  groupedBacklinksConfigPresetCore,
  groupedBacklinksDefaultsProp,
  groupedBacklinksOverridesPresetCore,
  groupedBacklinksOverridesProp,
  groupWithProp,
} from '@/plugins/grouped-backlinks/config'
import {keybindingsSettingsDataExtension} from '@/plugins/keybindings-settings/dataExtension'
import {
  keybindingOverridesPresetCore,
  keybindingOverridesProp,
} from '@/plugins/keybindings-settings/config'
import {quickFindPlugin} from '@/plugins/quick-find'
import {
  recentBlockIdsProp,
} from '@/plugins/quick-find/recents'
import {srsReschedulingDataExtension} from '@/plugins/srs-rescheduling/dataExtension'
import {
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '@/plugins/srs-rescheduling/schema'
import {srsReviewDataExtension} from '@/plugins/srs-review/dataExtension'
import {
  reviewDeckStartedProp,
  reviewDeckTagProp,
  reviewProgressProp,
} from '@/plugins/srs-review/schema'
import {startupMetricsPlugin} from '@/plugins/startup-metrics'
import {startupRecordProp} from '@/plugins/startup-metrics/record'
import {todoDataExtension} from '@/plugins/todo/dataExtension'
import {roamTodoStateProp, statusProp} from '@/plugins/todo/schema'
import {updateIndicatorPlugin} from '@/plugins/update-indicator'
import {
  currentLoadTimeProp,
  previousLoadTimeProp,
} from '@/plugins/update-indicator/loadTimes'
import {videoPlayerPlugin} from '@/plugins/video-player'
import {
  videoNotesPaneRatioProp,
} from '@/plugins/video-player/view'

interface SeedRegistrationCase {
  readonly label: string
  readonly extension: AppExtension
  readonly declarations: readonly AnyPropertySeedDeclaration[]
}

const registrationCases: readonly SeedRegistrationCase[] = [
  {label: 'attachments', extension: attachmentsPlugin, declarations: MEDIA_PROPERTY_SCHEMAS},
  {
    label: 'backlinks',
    extension: backlinksDataExtension,
    declarations: [backlinksFilterProp, dailyNoteBacklinksDefaultsProp],
  },
  {label: 'backlinks view', extension: backlinksViewPlugin, declarations: [backlinksViewProp]},
  {label: 'block tagging', extension: blockTaggingDataExtension, declarations: [blockTagsConfigProp]},
  {
    label: 'character counter',
    extension: characterCounterDataExtension,
    declarations: [charLimitProp, charScopeProp, charProfileProp],
  },
  {label: 'daily notes', extension: dailyNotesDataExtension, declarations: [dailyNoteDateProp]},
  {label: 'extensions settings', extension: extensionsDataExtension, declarations: [extensionsOverridesProp]},
  {label: 'geo', extension: geoDataExtension, declarations: GEO_PROPERTY_SCHEMAS},
  {
    label: 'grouped backlinks',
    extension: groupedBacklinksDataExtension,
    declarations: [groupedBacklinksDefaultsProp, groupedBacklinksOverridesProp, groupWithProp],
  },
  {
    label: 'keybindings settings',
    extension: keybindingsSettingsDataExtension,
    declarations: [keybindingOverridesProp],
  },
  {label: 'quick find', extension: quickFindPlugin, declarations: [recentBlockIdsProp]},
  {
    label: 'SRS rescheduling',
    extension: srsReschedulingDataExtension,
    declarations: [
      srsIntervalProp,
      srsFactorProp,
      srsNextReviewDateProp,
      srsReviewCountProp,
      srsGradeProp,
      srsArchivedProp,
      srsSnapshotHistoryProp,
    ],
  },
  {
    label: 'SRS review',
    extension: srsReviewDataExtension,
    declarations: [reviewDeckTagProp, reviewDeckStartedProp, reviewProgressProp],
  },
  {label: 'startup metrics', extension: startupMetricsPlugin, declarations: [startupRecordProp]},
  {label: 'todo', extension: todoDataExtension, declarations: [statusProp, roamTodoStateProp]},
  {
    label: 'update indicator',
    extension: updateIndicatorPlugin,
    declarations: [previousLoadTimeProp, currentLoadTimeProp],
  },
  {
    label: 'video player',
    extension: videoPlayerPlugin,
    declarations: [videoNotesPaneRatioProp],
  },
]

const allDeclarations = registrationCases.flatMap(({declarations}) => declarations)

describe('static plugin property seeds', () => {
  it.each(registrationCases)('$label contributes definition seeds', ({
    extension,
    declarations,
  }) => {
    const runtime = resolveFacetRuntimeSync(extension)
    const seeds = runtime.read(definitionSeedsFacet)

    expect(seeds).toEqual(expect.arrayContaining([...declarations]))
  })

  it('covers the complete static inventory with collision-free seed keys', () => {
    expect(allDeclarations).toHaveLength(43)
    expect(new Set(allDeclarations.map(declaration => declaration.seedKey))).toHaveProperty('size', 43)
  })

  it('keeps fixed code enums strict on write and lenient for historical reads', () => {
    const declarations: readonly AnyPropertySeedDeclaration[] = [
      charScopeProp,
      statusProp,
      roamTodoStateProp,
    ]
    for (const declaration of declarations) {
      expect(declaration.presetId).toBe('strict-enum')
      expect(declaration.codec.encode(declaration.defaultValue)).toBe(declaration.defaultValue)
      expect(declaration.codec.decode('historical-value')).toBe('historical-value')
      expect(() => declaration.codec.encode('historical-value' as never)).toThrow()
    }
  })

  it('preserves reference target constraints in declaration behavior and metadata', () => {
    expect(srsNextReviewDateProp.encodedConfig).toEqual({targetTypes: ['daily-note']})
    expect((srsNextReviewDateProp.codec as RefCodec).targetTypes).toEqual(['daily-note'])
    expect(locationProp.encodedConfig).toEqual({targetTypes: ['place']})
    expect((locationProp.codec as RefLikeCodec).targetTypes).toEqual(['place'])
  })

  it('preserves the grouped-backlinks core default without persisting an override', () => {
    expect(groupedBacklinksOverridesProp.hasExplicitDefault).toBe(false)
    expect(groupedBacklinksOverridesProp.defaultValue).toEqual({
      highPriorityTags: undefined,
      lowPriorityTags: undefined,
      excludedTags: undefined,
      excludedPatterns: undefined,
    })
  })

  it.each([
    [backlinksDataExtension, backlinksFilterPresetCore],
    [blockTaggingDataExtension, blockTagsConfigPresetCore],
    [extensionsDataExtension, extensionsOverridesPresetCore],
    [groupedBacklinksDataExtension, groupedBacklinksConfigPresetCore],
    [groupedBacklinksDataExtension, groupedBacklinksOverridesPresetCore],
    [keybindingsSettingsDataExtension, keybindingOverridesPresetCore],
  ] as const)('registers the exact custom core used by its declaration', (extension, core) => {
    expect(resolveFacetRuntimeSync(extension).read(valuePresetCoresFacet).get(core.id)).toBe(core)
  })
})
