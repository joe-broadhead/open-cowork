// Single seam between the desktop cloud host and the web workbench. The desktop main
// bundle inlines the website's SSR renderer + React client asset path through the
// declared `@open-cowork/website` package boundary (resolved to source via tsconfig
// paths / package exports) rather than reaching into `apps/website/src` with a
// relative cross-app path.
export { cloudWebsiteHtml as cloudBrowserAppHtml, CLOUD_WEB_REACT_CLIENT_ASSET_PATH } from '@open-cowork/website'
