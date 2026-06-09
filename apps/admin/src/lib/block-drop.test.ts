import { describe, expect, it } from "vitest";
import type { FieldDef } from "@paperboy/shared";
import { blockInstanceFromDrop } from "./block-drop.js";

// A content-area field; allowedBlocks empty = any block type allowed.
const area = (allowedBlocks: string[] = []): FieldDef =>
  ({
    name: "mainArea",
    displayName: "Main area",
    type: "contentArea",
    localized: true,
    required: false,
    delivery: "public",
    allowedBlocks,
    allowedTypes: [],
    group: "Content",
  }) as unknown as FieldDef;

const textField: FieldDef = { ...area(), name: "heading", type: "text" } as unknown as FieldDef;

describe("blockInstanceFromDrop", () => {
  it("builds a shared-block instance (ref, not inline) for an allowed block", () => {
    const r = blockInstanceFromDrop({ kind: "block", documentId: "doc1", blockType: "CardBlock" }, area(), "k1");
    expect(r).toEqual({ ok: true, block: { key: "k1", blockType: "CardBlock", display: "automatic", inline: null, ref: "doc1" } });
  });

  it("respects allowedBlocks — rejects a disallowed block type", () => {
    const r = blockInstanceFromDrop({ kind: "block", documentId: "doc1", blockType: "HeroBlock" }, area(["CardBlock"]), "k1");
    expect(r).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("allows a page drop (teaser) regardless of allowedBlocks", () => {
    const r = blockInstanceFromDrop({ kind: "page", documentId: "p1", blockType: "ArticlePage" }, area(["CardBlock"]), "k2");
    expect(r.ok).toBe(true);
  });

  it("rejects an unsupported kind (e.g. media)", () => {
    expect(blockInstanceFromDrop({ kind: "media", documentId: "m1", blockType: "x" }, area(), "k").ok).toBe(false);
  });

  it("rejects an incomplete payload", () => {
    expect(blockInstanceFromDrop({ kind: "block", documentId: "doc1" }, area(), "k")).toEqual({ ok: false, reason: "bad-payload" });
  });

  it("rejects a non-content-area target field", () => {
    expect(blockInstanceFromDrop({ kind: "block", documentId: "doc1", blockType: "CardBlock" }, textField, "k")).toEqual({ ok: false, reason: "not-area" });
  });
});
