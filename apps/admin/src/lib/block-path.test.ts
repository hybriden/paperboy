import { describe, expect, it } from "vitest";
import type { BlockInstance, ContentTypeDef, FieldDef } from "@paperboy/shared";
import { allowedBlockTypesFor } from "./area-add.js";
import { blockInstanceFromDrop } from "./block-drop.js";
import { blockAtPath, indexPathOf, resolveBlockPath, updateBlockAtPath } from "./block-path.js";

const makeBlock = (key: string, blockType: string, inline: Record<string, unknown> = {}): BlockInstance => ({
  key,
  blockType,
  display: "automatic",
  inline,
  ref: null,
});

describe("blockAtPath", () => {
  it("resolves a block at top level", () => {
    const b0 = makeBlock("k0", "Hero");
    const data = { mainArea: [b0] };
    expect(blockAtPath(data, [{ field: "mainArea", key: "k0" }])).toBe(b0);
  });

  it("resolves a nested block two levels deep", () => {
    const bInner = makeBlock("kInner", "Card");
    const bOuter = makeBlock("kOuter", "Columns", { columnsArea: [bInner] });
    const data = { mainArea: [bOuter] };

    const resolved = blockAtPath(data, [
      { field: "mainArea", key: "kOuter" },
      { field: "columnsArea", key: "kInner" },
    ]);
    expect(resolved).toBe(bInner);
  });

  it("returns null if any step does not exist", () => {
    const data = { mainArea: [makeBlock("k0", "Hero")] };
    expect(blockAtPath(data, [{ field: "mainArea", key: "missing" }])).toBeNull();
    expect(blockAtPath(data, [{ field: "wrongArea", key: "k0" }])).toBeNull();
  });
});

describe("resolveBlockPath", () => {
  it("maps index-based path to key-based BlockPath", () => {
    const bInner = makeBlock("kInner", "Card");
    const bOuter = makeBlock("kOuter", "Columns", { columnsArea: [bInner] });
    const data = { mainArea: [bOuter] };

    const resolved = resolveBlockPath(data, [
      { field: "mainArea", blockIndex: 0 },
      { field: "columnsArea", blockIndex: 0 },
    ]);
    expect(resolved).toEqual([
      { field: "mainArea", key: "kOuter" },
      { field: "columnsArea", key: "kInner" },
    ]);
  });

  it("returns null if an index is out of bounds", () => {
    const data = { mainArea: [makeBlock("k0", "Hero")] };
    expect(resolveBlockPath(data, [{ field: "mainArea", blockIndex: 5 }])).toBeNull();
  });

  it("returns null if field is missing or not an array", () => {
    const data = { title: "Hello" };
    expect(resolveBlockPath(data, [{ field: "mainArea", blockIndex: 0 }])).toBeNull();
  });
});

describe("updateBlockAtPath", () => {
  it("immutably updates a top-level block", () => {
    const b0 = makeBlock("k0", "Hero", { title: "Old" });
    const data = { mainArea: [b0] };

    const next = updateBlockAtPath(data, [{ field: "mainArea", key: "k0" }], (b) => ({
      ...b,
      inline: { ...b.inline, title: "New" },
    }));

    const nextArr = next.mainArea as BlockInstance[];
    expect(nextArr[0]?.inline?.title).toBe("New");
    expect((data.mainArea as BlockInstance[])[0]?.inline?.title).toBe("Old");
  });

  it("immutably updates a nested block two levels deep", () => {
    const bInner = makeBlock("kInner", "Card", { text: "Old" });
    const bOuter = makeBlock("kOuter", "Columns", { columnsArea: [bInner] });
    const data = { mainArea: [bOuter] };

    const next = updateBlockAtPath(
      data,
      [
        { field: "mainArea", key: "kOuter" },
        { field: "columnsArea", key: "kInner" },
      ],
      (b) => ({
        ...b,
        inline: { ...b.inline, text: "New" },
      }),
    );

    const nextOuter = (next.mainArea as BlockInstance[])[0]!;
    const nextColumns = (nextOuter.inline?.columnsArea as BlockInstance[] | undefined) ?? [];
    const nextInner = nextColumns[0]!;
    expect(nextInner.inline?.text).toBe("New");

    // Original data must be unchanged
    const origColumns = (bOuter.inline?.columnsArea as BlockInstance[] | undefined) ?? [];
    const origInner = origColumns[0]!;
    expect(origInner.inline?.text).toBe("Old");
  });

  it("returns original data if key is not found", () => {
    const b0 = makeBlock("k0", "Hero");
    const data = { mainArea: [b0] };
    const next = updateBlockAtPath(data, [{ field: "mainArea", key: "unknown" }], (b) => b);
    expect(next).toBe(data);
  });

  it("returns original data if a nested step key is not found", () => {
    const bInner = makeBlock("kInner", "Card");
    const bOuter = makeBlock("kOuter", "Columns", { columnsArea: [bInner] });
    const data = { mainArea: [bOuter] };
    const next = updateBlockAtPath(
      data,
      [
        { field: "mainArea", key: "kOuter" },
        { field: "columnsArea", key: "missing" },
      ],
      (b) => ({ ...b, key: "changed" }),
    );
    expect(next).toBe(data);
  });
});

describe("nested content area drop and add-block integration", () => {
  it("drops a block into a nested content area inside an inner block", () => {
    const bInner = makeBlock("kInner", "CardBlock", { text: "Existing inner card" });
    const bOuter = makeBlock("kOuter", "ColumnsBlock", { columnsArea: [bInner] });
    const data = { mainArea: [bOuter] };

    // Path from preview message for a drop on columnsArea inside bOuter (index 0)
    const msgPath = [{ field: "mainArea", blockIndex: 0 }];
    const resolvedPath = resolveBlockPath(data, msgPath);
    expect(resolvedPath).toEqual([{ field: "mainArea", key: "kOuter" }]);

    const parentBlock = blockAtPath(data, resolvedPath!);
    expect(parentBlock).toBe(bOuter);

    const droppedBlock = makeBlock("kNew", "CardBlock", { text: "Dropped card" });

    const nextData = updateBlockAtPath(data, resolvedPath!, (b) => {
      const inline = b.inline ?? {};
      const cur = inline.columnsArea;
      const current = Array.isArray(cur) ? (cur as BlockInstance[]) : [];
      return {
        ...b,
        inline: {
          ...inline,
          columnsArea: [droppedBlock, ...current],
        },
      };
    });

    const nextOuter = (nextData.mainArea as BlockInstance[])[0]!;
    const nextColumns = nextOuter.inline?.columnsArea as BlockInstance[];
    expect(nextColumns).toHaveLength(2);
    expect(nextColumns[0]?.key).toBe("kNew");
    expect(nextColumns[1]?.key).toBe("kInner");
  });

  it("adds a block into a two-level nested content area inside a second-level block", () => {
    const bLeaf = makeBlock("kLeaf", "TextBlock", { content: "Deep block" });
    const bInner = makeBlock("kInner", "AccordionItem", { itemArea: [bLeaf] });
    const bOuter = makeBlock("kOuter", "AccordionBlock", { accordionArea: [bInner] });
    const data = { mainArea: [bOuter] };

    // Target is itemArea inside bInner (index 0) inside bOuter (index 0)
    const msgPath = [
      { field: "mainArea", blockIndex: 0 },
      { field: "accordionArea", blockIndex: 0 },
    ];
    const resolvedPath = resolveBlockPath(data, msgPath);
    expect(resolvedPath).toEqual([
      { field: "mainArea", key: "kOuter" },
      { field: "accordionArea", key: "kInner" },
    ]);

    const targetBlock = blockAtPath(data, resolvedPath!);
    expect(targetBlock?.key).toBe("kInner");

    const addedBlock = makeBlock("kNewLeaf", "TextBlock", { content: "Newly added leaf" });

    const nextData = updateBlockAtPath(data, resolvedPath!, (b) => {
      const inline = b.inline ?? {};
      const cur = inline.itemArea;
      const current = Array.isArray(cur) ? (cur as BlockInstance[]) : [];
      return {
        ...b,
        inline: {
          ...inline,
          itemArea: [...current, addedBlock],
        },
      };
    });

    const nextOuter = (nextData.mainArea as BlockInstance[])[0]!;
    const nextAccordions = (nextOuter.inline?.accordionArea as BlockInstance[] | undefined) ?? [];
    const nextInner = nextAccordions[0]!;
    const nextItems = (nextInner.inline?.itemArea as BlockInstance[] | undefined) ?? [];
    expect(nextItems).toHaveLength(2);
    expect(nextItems[0]?.key).toBe("kLeaf");
    expect(nextItems[1]?.key).toBe("kNewLeaf");
  });

  it("enforces allowedBlocks schema validation on nested content areas", () => {
    // Nested area inside Columns allows ONLY "CardBlock"
    const columnsAreaDef: FieldDef = {
      name: "columnsArea",
      displayName: "Columns area",
      type: "contentArea",
      localized: true,
      required: false,
      delivery: "public",
      allowedBlocks: ["CardBlock"],
      allowedTypes: [],
      group: "Content",
    } as unknown as FieldDef;

    // Disallowed block drop rejected
    const disallowedDrop = blockInstanceFromDrop(
      { kind: "block", documentId: "docHero", blockType: "HeroBlock" },
      columnsAreaDef,
      "kNew",
    );
    expect(disallowedDrop).toEqual({ ok: false, reason: "not-allowed" });

    // Allowed block drop accepted
    const allowedDrop = blockInstanceFromDrop(
      { kind: "block", documentId: "docCard", blockType: "CardBlock" },
      columnsAreaDef,
      "kNew",
    );
    expect(allowedDrop.ok).toBe(true);

    // allowedBlockTypesFor only offers allowed types
    const types: ContentTypeDef[] = [
      { name: "HeroBlock", kind: "block", fields: [] } as unknown as ContentTypeDef,
      { name: "CardBlock", kind: "block", fields: [] } as unknown as ContentTypeDef,
    ];
    const offered = allowedBlockTypesFor(columnsAreaDef, types);
    expect(offered.map((t) => t.name)).toEqual(["CardBlock"]);
  });
});

describe("indexPathOf", () => {
  const data = {
    main: [
      { key: "a", blockType: "Hero", display: "automatic", inline: {}, ref: null },
      { key: "b", blockType: "Faq", display: "automatic", ref: null, inline: { items: [
        { key: "q1", blockType: "Q", display: "automatic", inline: {}, ref: null },
        { key: "q2", blockType: "Q", display: "automatic", inline: {}, ref: null },
      ] } },
    ],
  };
  it("turns a key path into the positions the preview counts, and back", () => {
    const path = [{ field: "main", key: "b" }, { field: "items", key: "q2" }];
    const indexes = indexPathOf(data, path);
    expect(indexes).toEqual([{ field: "main", blockIndex: 1 }, { field: "items", blockIndex: 1 }]);
    expect(resolveBlockPath(data, indexes!)).toEqual(path);
  });
  it("is null for a stale path", () => {
    expect(indexPathOf(data, [{ field: "main", key: "gone" }])).toBeNull();
  });
});
