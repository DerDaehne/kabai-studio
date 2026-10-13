import MarkdownIt from 'markdown-it';

const HEADING_SHIFT = 3;
const DEEPEST_HEADING = 6;

// html: false escapes raw tags like <script> instead of passing them through. Images are off because an <img src>
// would load an outside URL as soon as the text is shown (a way to carry data out, and there is no CSP); with the
// rule off, `![x](u)` stays visible as "!" plus a link the reader has to click. Only http(s) links are kept.
// breaks: agents write line by line, so a single newline stays a line break.
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
md.disable('image');
md.validateLink = (url) => /^https?:/i.test(url.trim());

const defaultLinkOpen =
	md.renderer.rules.link_open ??
	((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
	tokens[index].attrSet('rel', 'noopener noreferrer');
	return defaultLinkOpen(tokens, index, options, env, self);
};

// Agent headings sit below the page's own structure: # becomes h4, nothing goes deeper than h6.
md.core.ruler.push('shift_headings', (state) => {
	for (const token of state.tokens) {
		if (token.type !== 'heading_open' && token.type !== 'heading_close') continue;
		token.tag = `h${Math.min(DEEPEST_HEADING, Number(token.tag.slice(1)) + HEADING_SHIFT)}`;
	}
});

/** Renders agent or user markdown to safe HTML for `AgentText`. */
export const renderAgentText = (text: string): string => md.render(text);

function leafText(token: ReturnType<typeof md.parse>[number]): string {
	if (token.type === 'fence' || token.type === 'code_block') return token.content.trim();
	if (token.type !== 'inline') return '';
	return (token.children ?? [])
		.map((child) =>
			child.type === 'softbreak' || child.type === 'hardbreak' ? '\n' : child.content
		)
		.join('');
}

/** Top-level blocks that carry text, with the source line where each one ends. */
function textBlocks(text: string): { text: string; endLine: number }[] {
	const blocks: { parts: string[]; endLine: number }[] = [];
	for (const token of md.parse(text, {})) {
		if (token.level === 0 && token.map) blocks.push({ parts: [], endLine: token.map[1] });
		const part = leafText(token);
		if (part) blocks.at(-1)?.parts.push(part);
	}
	return blocks
		.map(({ parts, endLine }) => ({ text: parts.join(' '), endLine }))
		.filter((block) => block.text);
}

/** Markdown as plain text: no markers, blocks on their own lines. */
export const plainText = (text: string): string =>
	textBlocks(text)
		.map((block) => block.text)
		.join('\n');

/** The first block as plain text, and the markdown that follows it. */
export function splitLead(text: string): { lead: string; rest: string } {
	const first = textBlocks(text)[0];
	if (!first) return { lead: '', rest: '' };
	// markdown-it counts lines after turning a lone \r into \n, so the split has to as well.
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	return { lead: first.text, rest: lines.slice(first.endLine).join('\n').trim() };
}

/** The short form of an agent text: its first paragraph as plain text. */
export const leadText = (text: string): string => splitLead(text).lead;
