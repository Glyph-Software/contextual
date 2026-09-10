declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
}

declare module '*.sql' { const sql: string; export default sql; }
