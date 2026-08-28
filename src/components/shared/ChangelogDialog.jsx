import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import changelogMarkdown from '../../../CHANGELOG.md?raw';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/context/I18nContext';

const INLINE_TOKEN_RE = /(\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\((?:https?:\/\/)[^)]+\)|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;

function safeHref(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function renderInline(text, keyPrefix) {
  const source = String(text || '');
  const nodes = [];
  let cursor = 0;

  for (const match of source.matchAll(INLINE_TOKEN_RE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(source.slice(cursor, index));

    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={`${keyPrefix}-strong-${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeHref(link[2]) : null;
      nodes.push(href ? (
        <a
          key={`${keyPrefix}-link-${index}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-primary underline decoration-primary/50 underline-offset-2 transition-colors hover:text-foreground"
        >
          {link[1]}
        </a>
      ) : (link?.[1] || token));
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-code-${index}`} className="rounded-sm bg-secondary/70 px-1.5 py-0.5 font-mono text-[0.9em] text-foreground">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={`${keyPrefix}-em-${index}`}>{token.slice(1, -1)}</em>);
    }
    cursor = index + token.length;
  }

  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes.length ? nodes : source;
}

export function parseChangelog(markdown) {
  const lines = String(markdown || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };

  const addListItem = (ordered, text) => {
    flushParagraph();
    if (!list || list.ordered !== ordered) {
      flushList();
      list = { type: 'list', ordered, items: [] };
    }
    list.items.push(text);
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    const fence = trimmed.match(/^```(.*)$/);

    if (code) {
      if (fence) {
        blocks.push({ ...code, text: code.lines.join('\n') });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    if (fence) {
      flushParagraph();
      flushList();
      code = { type: 'code', language: fence[1].trim(), lines: [] };
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      addListItem(false, unordered[1]);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      addListItem(true, ordered[1]);
      continue;
    }

    if (/^(?:---+|___+|\*\s*\*\s*\*\s*)$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'rule' });
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'quote', text: trimmed.replace(/^>\s?/, '') });
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  if (code) blocks.push({ ...code, text: code.lines.join('\n') });
  flushParagraph();
  flushList();
  return blocks;
}

const headingClasses = {
  1: 'font-display text-3xl font-extrabold uppercase tracking-[0.01em] text-foreground',
  2: 'mt-8 border-b-2 border-border/80 pb-2 font-display text-xl font-extrabold uppercase tracking-[0.02em] text-foreground first:mt-0',
  3: 'mt-6 font-display text-sm font-extrabold uppercase tracking-[0.08em] text-primary',
  4: 'mt-5 font-semibold text-foreground',
  5: 'mt-4 font-semibold text-foreground',
  6: 'mt-4 font-semibold text-foreground',
};

function MarkdownBlock({ block, index }) {
  if (block.type === 'heading') {
    const Tag = `h${block.level}`;
    return <Tag className={headingClasses[block.level] || headingClasses[6]}>{renderInline(block.text, `${index}-heading`)}</Tag>;
  }

  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag className="my-3 space-y-2 pl-5 text-sm leading-6 text-muted-foreground marker:text-primary">
        {block.items.map((item, itemIndex) => (
          <li key={`${index}-${itemIndex}`}>{renderInline(item, `${index}-item-${itemIndex}`)}</li>
        ))}
      </Tag>
    );
  }

  if (block.type === 'code') {
    return (
      <pre className="my-4 overflow-x-auto rounded border border-border/70 bg-background/70 p-4 font-mono text-xs leading-6 text-foreground">
        <code>{block.text}</code>
      </pre>
    );
  }

  if (block.type === 'quote') {
    return <blockquote className="my-4 border-l-2 border-primary/70 pl-4 text-sm italic leading-6 text-muted-foreground">{renderInline(block.text, `${index}-quote`)}</blockquote>;
  }

  if (block.type === 'rule') return <hr className="my-6 border-border/70" />;

  return <p className="my-3 max-w-prose text-sm leading-7 text-muted-foreground">{renderInline(block.text, `${index}-paragraph`)}</p>;
}

export function ChangelogDialog({ open, onOpenChange, version }) {
  const t = useT();
  const blocks = useMemo(() => parseChangelog(changelogMarkdown), []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="changelog-dialog" className="flex max-w-3xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 gap-2 pr-14">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <FileText className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{t('whatsNew.title')}</DialogTitle>
              <DialogDescription className="mt-1 leading-5">{t('whatsNew.description')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="min-h-0 max-h-[70vh] flex-1 overflow-y-auto bg-background/35 px-5 py-6 sm:px-8">
          <article data-testid="changelog-content" className="changelog-content">
            {blocks.map((block, index) => <MarkdownBlock key={index} block={block} index={index} />)}
          </article>
        </DialogBody>

        <DialogFooter className="shrink-0">
          <span className="mr-auto text-xs text-muted-foreground">
            {version ? t('whatsNew.version', { version }) : null}
          </span>
          <Button size="sm" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
