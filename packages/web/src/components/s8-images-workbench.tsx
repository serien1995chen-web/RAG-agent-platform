'use client';

import { Alert, AlertDescription, AlertIcon, Box, Checkbox, Heading, Text } from '@chakra-ui/react';
import { useRef, useState } from 'react';
import { Button, Field, ProblemNotice, TextArea } from './knowledge-primitives';
import {
  S8ImageGallery,
  type S8ImageGalleryItem,
  type S8ImageGalleryLabels,
} from './s8-image-gallery';

export interface S8ImagesWorkbenchLabels extends S8ImageGalleryLabels {
  title: string;
  description: string;
  uploadTitle: string;
  uploadHint: string;
  choose: string;
  upload: string;
  uploading: string;
  uploaded: string;
  uploadFailed: string;
  invalidType: string;
  tooLarge: string;
  tooMany: string;
  searchTitle: string;
  query: string;
  queryPlaceholder: string;
  selectedImages: string;
  search: string;
  searching: string;
  partial: string;
  providerError: string;
  retry: string;
}

export interface S8ImageSearchResultItem {
  id: string;
  title: string;
  caption: string;
  citationId: string;
}

export interface S8ImagesWorkbenchProps {
  spaceId: string;
  items: readonly S8ImageGalleryItem[];
  labels: S8ImagesWorkbenchLabels;
  busy?: boolean;
  partial?: boolean;
  providerError?: boolean;
  error?: unknown;
  searchResults?: readonly S8ImageSearchResultItem[];
  onUpload: (files: readonly File[]) => Promise<readonly string[]>;
  onPreview: (item: S8ImageGalleryItem) => Promise<string>;
  onSearch: (input: { query: string; imageUploadIds: readonly string[] }) => Promise<void>;
  onRetry?: () => void;
}

const S8_IMAGE_MAX_BATCH = 10;
const S8_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function S8ImagesWorkbench(props: S8ImagesWorkbenchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadedIds, setUploadedIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [validationKey, setValidationKey] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);

  const chooseFiles = (next: File[]) => {
    setValidationKey(null);
    if (next.length > S8_IMAGE_MAX_BATCH) {
      setValidationKey('s8.images.tooMany');
      return;
    }
    if (next.some((file) => !/^image\/(png|jpeg|webp|gif)$/.test(file.type))) {
      setValidationKey('s8.images.invalidType');
      return;
    }
    if (next.some((file) => file.size < 1 || file.size > S8_IMAGE_MAX_BYTES)) {
      setValidationKey('s8.images.tooLarge');
      return;
    }
    setFiles(next);
  };

  const upload = async () => {
    if (files.length === 0) return;
    setUploading(true);
    setValidationKey(null);
    try {
      const ids = await props.onUpload(files);
      setUploadedIds([...ids]);
      setSelected([...ids]);
      setFiles([]);
    } catch {
      setValidationKey('s8.images.uploadFailed');
    } finally {
      setUploading(false);
    }
  };

  const search = async () => {
    setSearching(true);
    setSearchError(false);
    try {
      await props.onSearch({ query: query.trim(), imageUploadIds: selected });
    } catch {
      setSearchError(true);
    } finally {
      setSearching(false);
    }
  };

  return (
    <Box as="main" id="knowledge-main" minW={0}>
      <Heading as="h1" m={0} fontSize={{ base: '24px', md: '30px' }} letterSpacing={0}>
        {props.labels.title}
      </Heading>
      <Text mt={2} color="kn.inkMuted">
        {props.labels.description}
      </Text>

      <Box as="section" mt={7} minW={0}>
        <Heading as="h2" m={0} fontSize="lg">
          {props.labels.uploadTitle}
        </Heading>
        <Text mt={1} color="kn.inkMuted" fontSize="sm">
          {props.labels.uploadHint}
        </Text>
        <input
          ref={inputRef}
          hidden
          multiple
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label={props.labels.choose}
          onChange={(event) => chooseFiles([...(event.target.files ?? [])])}
        />
        <Box mt={3} display="flex" flexWrap="wrap" gap={2}>
          <Button size="sm" onClick={() => inputRef.current?.click()}>
            {props.labels.choose}
          </Button>
          <Button
            size="sm"
            tone="primary"
            busy={uploading}
            isDisabled={files.length === 0}
            onClick={() => void upload()}
          >
            {uploading ? props.labels.uploading : props.labels.upload}
          </Button>
        </Box>
        <Text mt={2} fontSize="sm" color="kn.inkMuted">
          {files.length > 0
            ? `${files.length} ${props.labels.uploadHint}`
            : uploadedIds.length > 0
              ? props.labels.uploaded
              : props.labels.uploadHint}
        </Text>
        {validationKey ? (
          <Alert mt={3} status="warning" variant="left-accent">
            <AlertIcon />
            <AlertDescription>
              {props.labels[validationKey as keyof S8ImagesWorkbenchLabels]}
            </AlertDescription>
          </Alert>
        ) : null}
      </Box>

      {props.partial ? (
        <Alert mt={5} status="warning" variant="left-accent">
          <AlertIcon />
          <AlertDescription>{props.labels.partial}</AlertDescription>
        </Alert>
      ) : null}
      {props.providerError ? (
        <Alert mt={5} status="error">
          <AlertIcon />
          <AlertDescription>{props.labels.providerError}</AlertDescription>
        </Alert>
      ) : null}
      {props.error ? <ProblemNotice error={props.error} onRetry={props.onRetry} /> : null}

      <Box as="section" mt={8} minW={0}>
        <S8ImageGallery items={props.items} labels={props.labels} onPreview={props.onPreview} />
      </Box>

      <Box as="section" mt={8} minW={0}>
        <Heading as="h2" m={0} fontSize="lg">
          {props.labels.searchTitle}
        </Heading>
        <Box mt={3}>
          <Field label={props.labels.query}>
            <TextArea
              value={query}
              placeholder={props.labels.queryPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
        </Box>
        <Box mt={3} display="flex" flexWrap="wrap" gap={3}>
          {props.items.map((item) => (
            <Checkbox
              key={item.id}
              isChecked={selected.includes(item.imageBlobRefId)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...new Set([...current, item.imageBlobRefId])]
                    : current.filter((id) => id !== item.imageBlobRefId),
                )
              }
            >
              {item.alt}
            </Checkbox>
          ))}
        </Box>
        <Text mt={2} fontSize="sm" color="kn.inkMuted">
          {props.labels.selectedImages} {selected.length}
        </Text>
        <Button
          mt={3}
          size="sm"
          tone="primary"
          busy={searching || props.busy}
          isDisabled={query.trim().length === 0 || selected.length === 0}
          onClick={() => void search()}
        >
          {searching ? props.labels.searching : props.labels.search}
        </Button>
        {searchError && !props.error ? (
          <Alert mt={3} status="error">
            <AlertIcon />
            <AlertDescription>{props.labels.providerError}</AlertDescription>
            {props.onRetry ? (
              <Button ml={3} size="xs" onClick={props.onRetry}>
                {props.labels.retry}
              </Button>
            ) : null}
          </Alert>
        ) : null}
        {props.searchResults && props.searchResults.length > 0 ? (
          <Box as="ol" mt={5} pl={5}>
            {props.searchResults.map((item) => (
              <Box as="li" key={item.citationId} mt={3} overflowWrap="anywhere">
                <Text as="strong">{item.title}</Text>
                <Text mt={1} color="kn.inkMuted">
                  {item.caption}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
