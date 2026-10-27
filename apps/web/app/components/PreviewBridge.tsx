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
export function PreviewBridge({ parentOrigins }: { parentOrigins: string[] }) {
  // parentOrigins pins the admins the bridge will talk to: inbound messages must
  // come from one of them, and outbound ones are addressed to them instead of "*".
  // The bridge always requires event.source to BE the embedding window, so this
  // is defence-in-depth — but it is what a customer copying this file should do.
  // Keyed on the joined string: a fresh array each render must not re-init.
  const key = parentOrigins.join(",");
  useEffect(() => initPreviewBridge({ accent: "#c8362f", parentOrigin: key ? key.split(",") : undefined }), [key]);
  return null;
}
