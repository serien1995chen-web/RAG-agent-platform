'use client';

import { Box, Code, Text } from '@chakra-ui/react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism';
import { vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import rehypeExternalLinks from 'rehype-external-links';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remend from 'remend';

const SAFE_MERMAID_TAGS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'marker',
  'use',
  'a',
  'title',
  'desc',
]);

const SAFE_MERMAID_ATTRS = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'marker-start',
  'marker-end',
  'marker-mid',
  'text-anchor',
  'dominant-baseline',
  'font-family',
  'font-size',
  'font-weight',
  'class',
  'id',
  'aria-label',
  'role',
]);

export const safeMarkdownSchema: SanitizeOptions = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
  },
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],
  },
};

export function sanitizeMermaidSvg(svg: string): string | null {
  if (typeof DOMParser === 'undefined') return null;
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror')) return null;
  const root = document.documentElement;
  if (root.tagName.toLowerCase() !== 'svg') return null;
  const elements = [root, ...root.querySelectorAll('*')];
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (!SAFE_MERMAID_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        !SAFE_MERMAID_ATTRS.has(attribute.name) ||
        name.startsWith('on') ||
        name === 'style' ||
        name === 'href' ||
        name === 'xlink:href' ||
        /^(?:javascript|data:text\/html):/i.test(value) ||
        /url\s*\(/i.test(value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return root.outerHTML;
}

export function S7MermaidBlock(props: { code: string; label: string }) {
  const id = `kb-mermaid-${useId().replaceAll(':', '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setFailed(false);
    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
          suppressErrorRendering: true,
        });
        const rendered = await mermaid.render(id, props.code);
        return sanitizeMermaidSvg(rendered.svg);
      })
      .then((value) => {
        if (!active) return;
        if (value) setSvg(value);
        else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id, props.code]);

  if (failed) {
    return (
      <Box as="pre" overflowX="auto" p={3} bg="gray.50" borderRadius="sm">
        <Code display="block" whiteSpace="pre">
          {props.code}
        </Code>
      </Box>
    );
  }
  if (!svg) {
    return (
      <Text as="span" role="status" fontSize="sm" color="gray.600">
        {props.label}
      </Text>
    );
  }
  return (
    <Box
      className="kb-mermaid"
      overflowX="auto"
      maxW="100%"
      aria-label={props.label}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const markdownComponents: Components = {
  code(props) {
    const { children, className, ...rest } = props;
    const value = String(children).replace(/\n$/, '');
    const match = /language-([\w-]+)/.exec(className ?? '');
    const language = match?.[1];
    if (language === 'mermaid') {
      return <S7MermaidBlock code={value} label="Mermaid diagram" />;
    }
    if (!language) {
      return (
        <Code {...rest} px={1} whiteSpace="pre-wrap">
          {value}
        </Code>
      );
    }
    return (
      <Box as="div" my={3} maxW="100%" overflowX="auto" className="kb-code-block">
        <SyntaxHighlighter
          language={language}
          style={vs}
          PreTag="div"
          customStyle={{ margin: 0, fontSize: '13px', background: '#f7faf9' }}
        >
          {value}
        </SyntaxHighlighter>
      </Box>
    );
  },
  a(props) {
    const external = /^https?:\/\//i.test(props.href ?? '');
    return <a {...props} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} />;
  },
};

export function S7MarkdownRenderer(props: { children: string; className?: string }) {
  const repaired = remend(props.children, {
    htmlTags: true,
    links: true,
    images: true,
    katex: true,
    inlineKatex: true,
  });
  return (
    <Box className={props.className} minW={0} overflowWrap="anywhere">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, safeMarkdownSchema],
          rehypeKatex,
          [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
        ]}
        components={markdownComponents}
      >
        {repaired}
      </ReactMarkdown>
    </Box>
  );
}

export function MarkdownRawPreview(props: { children: ReactNode }) {
  return <Box as="div">{props.children}</Box>;
}
