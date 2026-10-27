'use client';

import { Badge, Box, Flex, Heading, Link, Text } from '@chakra-ui/react';
import type { CitationApi } from '@kb/contracts';
import { S7MarkdownRenderer } from './s7-markdown-renderer';

export interface S7CitationViewLabels {
  source: string;
  range: string;
  version: string;
  citation: string;
}

export function S7CitationView(props: {
  citation: CitationApi;
  content: string;
  labels: S7CitationViewLabels;
}) {
  const external = props.citation.sourceUrl
    ? /^https?:\/\//i.test(props.citation.sourceUrl)
    : false;
  return (
    <Box
      as="article"
      className="s7-citation"
      borderLeftWidth="3px"
      borderColor="kn.primary"
      pl={4}
      py={2}
      minW={0}
    >
      <Flex align="flex-start" justify="space-between" gap={3} wrap="wrap">
        <Box minW={0}>
          <Text m={0} fontSize="xs" color="kn.inkMuted">
            {props.labels.citation}
          </Text>
          <Heading as="h3" m={0} mt={1} fontSize="md" letterSpacing={0} overflowWrap="anywhere">
            {props.citation.sourceUrl && external ? (
              <Link
                href={props.citation.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                color="kn.primary"
              >
                {props.citation.title}
              </Link>
            ) : (
              props.citation.title
            )}
          </Heading>
        </Box>
        <Flex gap={2} wrap="wrap">
          <Badge variant="outline" borderColor="kn.line" color="kn.ink" bg="kn.surface">
            {props.labels.range} {props.citation.segmentRange.start}-
            {props.citation.segmentRange.end}
          </Badge>
          <Badge variant="outline" borderColor="kn.line" color="kn.ink" bg="kn.surface">
            {props.labels.version} {props.citation.version}
          </Badge>
        </Flex>
      </Flex>
      <Text m={0} mt={2} fontSize="xs" color="kn.inkMuted">
        {props.labels.source} {props.citation.sourceId}
      </Text>
      <S7MarkdownRenderer className="s7-citation-body">{props.content}</S7MarkdownRenderer>
    </Box>
  );
}
