"use client";
import { useEffect } from "react";
import { initPreviewBridge } from "@paperboycms/preview";

/**
 * Visual on-page editing bridge — runs ONLY in the preview iframe (draft mode).
 *
 * Thin React wrapper over the shared, framework-agnostic bridge runtime: the
 * behavior (click-to-edit, drag-drop blocks, rect streaming, live patch, scroll
 * persistence) and the message protocol live in @paperboycms/preview, so this
 * frontend, Neoteric, and the CMS admin all share one contract instead of
 * hand-rolled copies that drift.
 */
export function PreviewBridge({ parentOrigin }: { parentOrigin?: string }) {
  // parentOrigin pins the admin the bridge will talk to: inbound messages must
  // come from it, and outbound ones are addressed to it instead of "*". The bridge
  // always requires event.source to BE the embedding window, so this is
  // defence-in-depth — but it is what a customer copying this file should do.
  useEffect(() => initPreviewBridge({ accent: "#c8362f", parentOrigin }), [parentOrigin]);
  return null;
}
