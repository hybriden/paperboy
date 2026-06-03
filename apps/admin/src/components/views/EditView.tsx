import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api.js";
import { Icon } from "../../lib/icons.js";
import { useIsMobile } from "../../lib/useMediaQuery.js";
import { useUser } from "../../lib/user.js";
import { AssetPane } from "../AssetPane.js";
import { Editor } from "../Editor.js";
import type { ShellOutlet } from "../Shell.js";
import { Tree } from "../Tree.js";
import { ResizeHandle } from "../ui/resize.js";
import { AutoHideRail, PinButton, usePinned } from "../ui/SidePane.js";

export function EditView() {
  const { setCrumb } = useOutletContext<ShellOutlet>();
  const { documentId } = useParams();
  const [params, setParams] = useSearchParams();
  const locale = params.get("lang") ?? "en";
  const navigate = useNavigate();
  const { user } = useUser();
  const isMobile = useIsMobile();

  const locales = useQuery({ queryKey: ["locales"], queryFn: ({ signal }) => api.locales(signal) });
  const types = useQuery({ queryKey: ["content-types"], queryFn: ({ signal }) => api.contentTypes(signal) });
  const site = useQuery({ queryKey: ["site"], queryFn: ({ signal }) => api.site(signal) });
  const canCreate = user.permissions.includes("content.create");
  const canDelete = user.permissions.includes("content.delete");

  // Opening Edit with nothing selected defaults to the configured start page ("/")
  // on desktop, so the editor isn't empty. Mobile keeps its list-first flow.
  // Falls back to the Welcome screen when no start page is configured.
  useEffect(() => {
    if (documentId || isMobile) return;
    const startId = site.data?.startPageId;
    if (startId) navigate(`/edit/${startId}${locale !== "en" ? `?lang=${locale}` : ""}`, { replace: true });
  }, [documentId, isMobile, site.data?.startPageId, locale, navigate]);

  const setLocale = useCallback(
    (l: string) => {
      if (documentId) navigate(`/edit/${documentId}?lang=${l}`);
    },
    [documentId, navigate],
  );

  // Each side pane can be pinned (always shown, in-flow) or set to auto-hide
  // (collapsed to an edge rail that flies out on hover).
  const [treePinned, toggleTree] = usePinned("pb-pin-tree", true);
  const [assetsPinned, toggleAssets] = usePinned("pb-pin-assets", true);

  const select = (id: string) => navigate(`/edit/${id}${locale !== "en" ? `?lang=${locale}` : ""}`);

  const tree = (
    <Tree
      selectedId={documentId ?? null}
      onSelect={select}
      canCreate={canCreate}
      canDelete={canDelete}
      types={types.data ?? []}
      locale={locale}
      headerActions={<PinButton pinned={treePinned} onToggle={toggleTree} />}
    />
  );
  const assets = (
    <AssetPane
      blockTypes={(types.data ?? []).filter((t) => t.kind === "block")}
      selectedId={documentId ?? null}
      onSelect={select}
      canCreate={canCreate}
      headerActions={<PinButton pinned={assetsPinned} onToggle={toggleAssets} />}
    />
  );

  // Phones can't fit the resizable multi-pane workspace, so show one thing at a
  // time: the page list (tree) until a document is picked, then the editor with
  // a back link. No assets pane / no live preview — simple edit-only flow.
  if (isMobile) {
    return documentId ? (
      <div className="flex h-full flex-col">
        <button
          onClick={() => navigate("/edit")}
          className="flex shrink-0 items-center gap-1.5 border-b border-line bg-panel px-3 py-2.5 text-sm font-medium text-accent-700"
        >
          <Icon.ChevronDown width={16} height={16} className="rotate-90" />
          All pages
        </button>
        <div className="min-h-0 flex-1">
          <Editor
            key={documentId + locale}
            documentId={documentId}
            locale={locale}
            setLocale={setLocale}
            locales={locales.data ?? []}
            types={types.data ?? []}
            user={user}
            onName={setCrumb}
            mobile
          />
        </div>
      </div>
    ) : (
      <div className="flex h-full flex-col bg-panel">{tree}</div>
    );
  }

  return (
    // Resizable workspace — drag the dividers to give the editor/preview more room.
    // Each side pane is pinned (in-flow) or auto-hidden (edge rail + hover flyout).
    // The PanelGroup is keyed by the pin config so each layout persists separately.
    <div className="relative flex h-full">
      {!treePinned && (
        <AutoHideRail side="left" label="Content" onPin={toggleTree}>
          <div className="flex h-full flex-col border-r border-line bg-panel">{tree}</div>
        </AutoHideRail>
      )}
      <PanelGroup
        key={`wg-${treePinned ? "t" : ""}-${assetsPinned ? "a" : ""}`}
        autoSaveId={`paperboy-workspace-${treePinned ? "t" : "x"}${assetsPinned ? "a" : "x"}`}
        direction="horizontal"
        className="min-w-0 flex-1"
      >
        {treePinned && (
          <>
            <Panel id="tree" order={1} defaultSize={20} minSize={12} collapsible collapsedSize={0} className="flex flex-col border-r border-line bg-panel">
              {tree}
            </Panel>
            <ResizeHandle />
          </>
        )}
        <Panel id="editor" order={2} minSize={30} className="min-w-0">
          {documentId ? (
            <Editor
              key={documentId + locale}
              documentId={documentId}
              locale={locale}
              setLocale={setLocale}
              locales={locales.data ?? []}
              types={types.data ?? []}
              user={user}
              onName={setCrumb}
              widePreview={!assetsPinned}
            />
          ) : site.isLoading || site.data?.startPageId ? (
            // Resolving / about to redirect to the start page — no Welcome flash.
            <div className="grid h-full place-items-center text-muted">Loading…</div>
          ) : (
            <Welcome onClearCrumb={() => setCrumb(null)} />
          )}
        </Panel>
        {assetsPinned && (
          <>
            <ResizeHandle />
            <Panel id="assets" order={3} defaultSize={18} minSize={12} collapsible collapsedSize={0} className="min-w-0">
              {assets}
            </Panel>
          </>
        )}
      </PanelGroup>
      {!assetsPinned && (
        <AutoHideRail side="right" label="Assets" onPin={toggleAssets}>
          <div className="flex h-full flex-col border-l border-line bg-panel">{assets}</div>
        </AutoHideRail>
      )}
    </div>
  );
}

function Welcome({ onClearCrumb }: { onClearCrumb: () => void }) {
  onClearCrumb();
  return (
    <div className="grid h-full place-items-center p-10 text-center">
      <div className="max-w-md animate-slide-up">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-accent/10 text-accent">
          <Icon.Edit width={28} height={28} />
        </div>
        <h2 className="masthead text-2xl text-fg">Edit the front page</h2>
        <p className="mt-2 text-sm text-muted">
          Choose a story from the tree, or press <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-xs">⌘K</kbd> to
          search and jump anywhere. Compose with blocks, translate, preview, publish.
        </p>
      </div>
    </div>
  );
}
