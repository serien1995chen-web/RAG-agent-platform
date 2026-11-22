'use client';

import { Badge, Box, Flex, Heading, Link, Text } from '@chakra-ui/react';
import type { CitationApi } from '@kb/contracts';
import { S7MarkdownRenderer } from './s7-markdown-renderer';

export interface S7CitationViewLabels {
  source: string;
  space: string;
  score: string;
  range: string;
  version: string;
  citation: string;
  quote: string;
  details: string;
  snapshotHash: string;
  expiresAt: string;
}

export function S7CitationView(props: { citation: CitationApi; labels: S7CitationViewLabels }) {
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
          <Badge
            variant="outline"
            borderColor="kn.line"
            color="kn.ink"
            bg="kn.surface"
            maxW="100%"
            overflowWrap="anywhere"
            whiteSpace="normal"
            wordBreak="break-all"
          >
            {props.labels.space} {props.citation.knowledgeSpaceId}
          </Badge>
          <Badge variant="outline" borderColor="kn.line" color="kn.ink" bg="kn.surface">
            {props.labels.score} {props.citation.score.toFixed(4)}
          </Badge>
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
      <Text m={0} mt={3} fontSize="xs" fontWeight="semibold" color="kn.inkMuted">
        {props.labels.quote}
      </Text>
      <S7MarkdownRenderer className="s7-citation-body">
        {props.citation.quoteText}
      </S7MarkdownRenderer>
      <Box as="details" mt={3} fontSize="xs" color="kn.inkMuted">
        <Box as="summary" cursor="pointer" overflowWrap="anywhere">
          {props.labels.details}
        </Box>
        <Flex mt={2} gap={2} wrap="wrap" direction="column">
          <Text m={0} overflowWrap="anywhere">
            {props.labels.citation} {props.citation.citationId}
          </Text>
          <Text m={0} overflowWrap="anywhere">
            {props.labels.snapshotHash} {props.citation.snapshotHash}
          </Text>
          <Text as="time" m={0} dateTime={props.citation.expiresAt} overflowWrap="anywhere">
            {props.labels.expiresAt} {props.citation.expiresAt}
          </Text>
        </Flex>
      </Box>
    </Box>
  );
}
