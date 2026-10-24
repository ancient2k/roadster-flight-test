// Build version (vite.config.ts `define`): package.json version and the short commit of the build.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const APP_COMMIT: string = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : '';
/** "v1.1.0 · a85f503" */
export const versionLabel = (): string => `v${APP_VERSION}${APP_COMMIT ? ` · ${APP_COMMIT}` : ''}`;
