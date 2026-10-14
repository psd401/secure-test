---
type: Subsystem Reference
title: Stimulus, item sets and multi-source readings
description: How item sets share one stimulus across consecutive questions, how labelled multi-source readings and E12 source-backed sets are authored, delivered per student, checked before publish and rendered in the student client.
tags: [stimulus, item-sets, multi-source, e12, authoring, delivery]
openwiki:
  roles: [domain, workflow]
  change_kinds: [public-api, persistence, lifecycle]
  source_paths:
    - design-tool/lib/api/itemSets.ts
    - design-tool/lib/api/itemSetsBundle.ts
    - design-tool/lib/api/setSources.ts
    - design-tool/lib/api/buildDeliveryBundle.ts
    - design-tool/app/dashboard/[id]/readiness.ts
    - packages/schema/src/items.ts
    - client/SecureTestCore/Sources/SecureTestCore/AssessmentPage.swift
    - client/SecureTestCore/Sources/SecureTestCore/DeliveryBundle.swift
  symbols: [CreateItemSetBody, UpdateItemSetBody, StimulusSources, isContiguousRun, splitSetInOrder, resolveSourceText, composeStimulus, applySourcesToSets, stimulusGaps, ItemSetSchema, StimulusSourceSchema, layoutOf]
  test_paths:
    - design-tool/test/item-sets-api.test.ts
    - design-tool/test/delivery-api.test.ts
    - design-tool/test/import-api.test.ts
    - design-tool/test/item-readiness.test.ts
    - design-tool/test/preview-render.test.ts
    - design-tool/test/pdf-extract.test.ts
    - design-tool/test/work-packet-page.test.tsx
    - client/SecureTestCore/Tests/SecureTestCoreTests/RendererSourcePaneTests.swift
    - client/SecureTestCore/Tests/SecureTestCoreTests/RendererStimulusTests.swift
    - client/SecureTestCore/Tests/SecureTestCoreTests/RendererLayoutToggleTests.swift
    - client/SecureTestCore/Tests/SecureTestCoreTests/RendererOutlineTests.swift
  invariants:
    - Items of one item set are contiguous in position order, and a set sits where its first item sits.
    - Labelled sources are replaced whole on write, at most 12, with a label of 1 to 80 characters and text of at most 20,000 characters.
    - Source writes are refused with 409 once the assessment is published.
    - A student never receives the teacher-only E12 source link; the student bundle carries only resolved stimulus text and the outline fields.
    - Per-student E12 resolution never stores anything per student for the set.
  validation_commands:
    - cd design-tool && bun test test/item-readiness.test.ts
    - cd client/SecureTestCore && swift test --filter RendererSourcePaneTests
---
