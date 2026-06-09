/**
 * @paperboycms/preview — the browser-side on-page-editing bridge for the
 * Paperboy headless CMS preview iframe.
 *
 *   import { initPreviewBridge } from "@paperboycms/preview";
 *   if (inPreview) initPreviewBridge(); // call once inside the iframe
 *
 * The admin (parent window) imports the contract type-only, with no DOM code:
 *
 *   import { parsePreviewMessage, patchMessage } from "@paperboycms/preview/protocol";
 */
export * from "./protocol.js";
export { initPreviewBridge, type PreviewBridgeOptions } from "./bridge.js";
