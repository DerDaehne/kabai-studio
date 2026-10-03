import MarkdownIt from 'markdown-it';

// html: false already escapes raw tags like <script> instead of passing them through, and markdown-it's default
// validateLink rejects javascript:/vbscript:/file: schemes — both checked by markdown.test.ts.
const md = new MarkdownIt({ html: false, linkify: false });

/** Renders a ticket description from markdown to safe HTML for `{@html}`. */
export const renderDescription = (text: string): string => md.render(text);
