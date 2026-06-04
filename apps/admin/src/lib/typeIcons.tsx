import { useQuery } from "@tanstack/react-query";
import {
  Archive, Award, Bell, Blocks, BookOpen, Bookmark, Box, Boxes, Briefcase,
  Building2, Calendar, Camera, Car, Clock, Code, Coffee, Compass, Component,
  Database, File, FileText, Files, Flag, Flame, Folder, FolderOpen, Globe,
  GraduationCap, Heart, Home, Image, Images, Inbox, Key, Landmark, Layers,
  LayoutDashboard, LayoutGrid, LayoutList, LayoutTemplate, Leaf, Library,
  Lightbulb, Link, List, Lock, Mail, Map as MapIcon, MapPin, Megaphone, MessageSquare,
  Music, Newspaper, Package, Palette, Pencil, Phone, Plane, Puzzle, Quote,
  Rocket, Rss, Search, Server, Settings, Shield, ShoppingCart, SlidersHorizontal,
  Sparkles, Square, Star, Store, Table, Tag, Tags, Target, Terminal, Type,
  User, Users, Video, Wrench, Zap,
  type LucideIcon,
} from "lucide-react";
import { api } from "./api.js";

/**
 * The curated icon set for content types (lucide-react, kebab-case names —
 * the stored value). A deliberate subset: a full icon library in the picker
 * would bloat the bundle and the choice; ~80 covers CMS modelling needs.
 */
export const TYPE_ICONS: ReadonlyArray<readonly [string, LucideIcon]> = [
  // documents & layout
  ["file", File], ["file-text", FileText], ["files", Files], ["newspaper", Newspaper],
  ["book-open", BookOpen], ["library", Library], ["layout-template", LayoutTemplate],
  ["layout-grid", LayoutGrid], ["layout-list", LayoutList], ["layout-dashboard", LayoutDashboard],
  ["layers", Layers], ["square", Square], ["blocks", Blocks], ["component", Component],
  ["puzzle", Puzzle], ["box", Box], ["boxes", Boxes], ["package", Package],
  // media
  ["image", Image], ["images", Images], ["camera", Camera], ["video", Video], ["music", Music],
  // places & navigation
  ["globe", Globe], ["map", MapIcon], ["map-pin", MapPin], ["compass", Compass], ["home", Home],
  ["building-2", Building2], ["landmark", Landmark], ["store", Store],
  // commerce & tags
  ["shopping-cart", ShoppingCart], ["tag", Tag], ["tags", Tags],
  // system
  ["settings", Settings], ["wrench", Wrench], ["sliders-horizontal", SlidersHorizontal],
  ["database", Database], ["server", Server], ["code", Code], ["terminal", Terminal],
  // people & contact
  ["user", User], ["users", Users], ["mail", Mail], ["message-square", MessageSquare], ["phone", Phone],
  // time
  ["calendar", Calendar], ["clock", Clock],
  // marketing & misc
  ["star", Star], ["heart", Heart], ["award", Award], ["target", Target], ["flag", Flag],
  ["bookmark", Bookmark], ["bell", Bell], ["megaphone", Megaphone], ["rss", Rss], ["link", Link],
  ["search", Search], ["lightbulb", Lightbulb], ["rocket", Rocket], ["zap", Zap], ["flame", Flame],
  ["leaf", Leaf], ["coffee", Coffee], ["car", Car], ["plane", Plane], ["briefcase", Briefcase],
  ["graduation-cap", GraduationCap], ["shield", Shield], ["lock", Lock], ["key", Key],
  ["folder", Folder], ["folder-open", FolderOpen], ["archive", Archive], ["inbox", Inbox],
  ["list", List], ["table", Table], ["quote", Quote], ["type", Type], ["pencil", Pencil],
  ["palette", Palette], ["sparkles", Sparkles],
];

const BY_NAME: ReadonlyMap<string, LucideIcon> = new Map(TYPE_ICONS);

/** Values stored before the lucide set (or by older seeds) → lucide names. */
const LEGACY: Record<string, string> = {
  block: "blocks",
  dashboard: "layout-dashboard",
};

export function resolveTypeIcon(name: string | undefined | null, fallback = "file"): LucideIcon {
  const key = name ? (LEGACY[name] ?? name) : fallback;
  return BY_NAME.get(key) ?? BY_NAME.get(fallback) ?? File;
}

/** Render a content-type icon by its stored name (lucide subset + legacy aliases). */
export function TypeIcon({
  name,
  fallback,
  ...svg
}: { name: string | undefined | null; fallback?: string } & React.ComponentProps<LucideIcon>) {
  const Cmp = resolveTypeIcon(name, fallback);
  return <Cmp {...svg} />;
}

/**
 * Icon name for a content TYPE name (e.g. "BlogPost" → its configured icon),
 * via the shared ["content-types"] query — usable in any row without prop
 * threading. Returns undefined while loading / for unknown types.
 */
export function useTypeIconName(typeName: string): string | undefined {
  const q = useQuery({
    queryKey: ["content-types"],
    queryFn: ({ signal }) => api.contentTypes(signal),
    staleTime: 60_000,
  });
  return q.data?.find((t) => t.name === typeName)?.icon;
}
