export interface WebAssetManifest {
  css: string;
  js: string;
}

export interface ShellNavItem {
  label: string;
  href: string;
  active?: boolean;
}

export interface PaletteSuggestion {
  title: string;
  href: string;
  type?: string;
  summary?: string;
}

export interface ShellOptions {
  title: string;
  workspaceTitle: string;
  active?: string;
  identityLabel?: string;
  identityTitle?: string;
  assetBase?: string;
  assetManifest?: WebAssetManifest;
  navItems?: ShellNavItem[];
  sidebar?: string;
  rightRail?: string;
  main: string;
  footer?: string;
  bodyClass?: string;
  basePrefix?: string;
  searchIndexHref?: string;
  searchApiHref?: string;
  graphHref?: string;
  paletteSuggestions?: PaletteSuggestion[];
}

export interface TocItem {
  id: string;
  level: number;
  text: string;
}

export interface MarkdownRenderOptions {
  resolveWikiLink?: (target: string) => string | undefined;
  resolveLink?: (href: string) => string | undefined;
}

export interface MarkdownRenderResult {
  html: string;
  toc: TocItem[];
}

interface MarkdownListItem {
  text: string;
  checked?: boolean;
  children?: MarkdownListFrame[];
}

interface MarkdownListFrame {
  type: "ul" | "ol";
  indent: number;
  items: MarkdownListItem[];
}

export const DEFAULT_WEB_ASSET_MANIFEST: WebAssetManifest = {
  css: "openwiki.css",
  js: "openwiki.js",
};
