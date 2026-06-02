import type { SVGProps } from "react";

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const Icon = {
  Dashboard: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
  ),
  Content: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M4 4h16v16H4z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
  ),
  Edit: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
  ),
  Settings: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 11 3V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 16 4.6Z" /></svg>
  ),
  Api: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
  ),
  File: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
  ),
  Block: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>
  ),
  Chevron: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><polyline points="9 18 15 12 9 6" /></svg>
  ),
  Globe: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20" /></svg>
  ),
  Plus: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
  ),
  Trash: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
  ),
  Up: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><polyline points="18 15 12 9 6 15" /></svg>),
  Down: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><polyline points="6 9 12 15 18 9" /></svg>),
  Eye: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></svg>
  ),
  Grip: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><circle cx="9" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="18" r="1" /></svg>
  ),
  X: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>),
  Pin: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M12 17v5" /><path d="M9 10.8V4h6v6.8a2 2 0 0 0 .5 1.3L17 14H7l1.5-1.9a2 2 0 0 0 .5-1.3Z" /></svg>
  ),
  PinOff: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M12 17v5" /><path d="M9 10.8V4h6v6.8a2 2 0 0 0 .5 1.3L17 14H7l1.5-1.9a2 2 0 0 0 .5-1.3Z" /><path d="M3 3l18 18" /></svg>
  ),
  Sun: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
  ),
  Moon: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>),
  Monitor: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
  ),
  Search: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>),
  ChevronDown: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><polyline points="6 9 12 15 18 9" /></svg>),
  Dots: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
  ),
  Help: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 2.5" /><path d="M12 17h.01" /></svg>
  ),
  History: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></svg>
  ),
  Bold: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z" /></svg>),
  Italic: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M19 4h-9M14 20H5M15 4 9 20" /></svg>),
  Heading: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M6 4v16M18 4v16M6 12h12" /></svg>),
  ListBullet: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
  ),
  Quote: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M3 21c3 0 7-1 7-8V5H3v7h4M14 21c3 0 7-1 7-8V5h-7v7h4" /></svg>
  ),
  Link: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
  ),
  Undo: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></svg>),
  Redo: (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></svg>),
  Copy: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
  ),
  Image: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>
  ),
};
