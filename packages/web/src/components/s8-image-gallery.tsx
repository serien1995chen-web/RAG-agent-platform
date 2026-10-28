'use client';

import { Alert, AlertDescription, AlertIcon, Box, Grid, Text } from '@chakra-ui/react';
import { useEffect, useRef, useState } from 'react';
import { PhotoSlider } from 'react-photo-view';
import 'react-photo-view/dist/react-photo-view.css';
import { Button, StatusTag } from './knowledge-primitives';

export interface S8ImageGalleryItem {
  id: string;
  imageBlobRefId: string;
  alt: string;
  caption: string;
  captionStatus: 'pending' | 'indexed' | 'error';
  vectorStatus: 'pending' | 'indexed' | 'error';
}

export interface S8ImageGalleryLabels {
  empty: string;
  preview: string;
  loadingPreview: string;
  previewExpired: string;
  caption: string;
  captionStatus: string;
  vectorStatus: string;
  close: string;
}

export interface S8ImagePreview {
  url: string;
  expiresAt: string;
}

export interface S8ImageGalleryProps {
  items: readonly S8ImageGalleryItem[];
  labels: S8ImageGalleryLabels;
  onPreview: (item: S8ImageGalleryItem) => Promise<S8ImagePreview>;
}

export function S8ImageGallery(props: S8ImageGalleryProps) {
  const [active, setActive] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, S8ImagePreview>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all(
      props.items.map(async (item) => {
        try {
          return [item.id, await props.onPreview(item)] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!active) return;
      const next = Object.fromEntries(entries.filter((entry) => entry !== null));
      if (Object.keys(next).length > 0) {
        setPreviews((current) => ({ ...current, ...next }));
      }
    });
    return () => {
      active = false;
    };
  }, [props.items, props.onPreview]);

  if (props.items.length === 0) {
    return (
      <Alert status="info" variant="left-accent">
        <AlertIcon />
        <AlertDescription>{props.labels.empty}</AlertDescription>
      </Alert>
    );
  }

  const open = async (item: S8ImageGalleryItem, index: number, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setLoading(item.id);
    setFailed(false);
    try {
      const cached = previews[item.id];
      const preview =
        cached && Date.parse(cached.expiresAt) > Date.now() + 5_000
          ? cached
          : await props.onPreview(item);
      setPreviews((current) => ({ ...current, [item.id]: preview }));
      setUrl(preview.url);
      setActive(index);
    } catch {
      setFailed(true);
    } finally {
      setLoading(null);
    }
  };

  const close = () => {
    setActive(null);
    setUrl(null);
    globalThis.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <Box minW={0}>
      <Grid
        as="ul"
        p={0}
        m={0}
        listStyleType="none"
        templateColumns={{
          base: 'minmax(0, 1fr)',
          md: 'repeat(2, minmax(0, 1fr))',
          xl: 'repeat(3, minmax(0, 1fr))',
        }}
        gap={4}
      >
        {props.items.map((item, index) => (
          <Box
            as="li"
            key={item.id}
            minW={0}
            borderWidth="1px"
            borderColor="kn.line"
            bg="kn.surface"
            borderRadius="sm"
            overflow="hidden"
          >
            <Box
              display="flex"
              alignItems="center"
              justifyContent="center"
              aspectRatio="4 / 3"
              bg="kn.surfaceMuted"
              color="kn.inkMuted"
              fontSize="sm"
            >
              {previews[item.id]?.url ? (
                <Box
                  as="img"
                  src={previews[item.id]!.url}
                  alt={item.alt}
                  width="100%"
                  height="100%"
                  objectFit="cover"
                  onError={() =>
                    setPreviews((current) => {
                      const next = { ...current };
                      delete next[item.id];
                      return next;
                    })
                  }
                />
              ) : (
                item.alt
              )}
            </Box>
            <Box p={4} minW={0}>
              <Text m={0} fontWeight="700" overflowWrap="anywhere">
                {item.alt}
              </Text>
              {item.caption ? (
                <Text mt={2} mb={0} color="kn.inkMuted" noOfLines={3} overflowWrap="anywhere">
                  {item.caption}
                </Text>
              ) : null}
              <Box mt={3} display="flex" flexWrap="wrap" gap={2}>
                <Text as="span" fontSize="xs" color="kn.inkMuted">
                  {props.labels.captionStatus}
                </Text>
                <StatusTag
                  value={item.captionStatus}
                  tone={item.captionStatus === 'error' ? 'warning' : 'neutral'}
                />
                <Text as="span" fontSize="xs" color="kn.inkMuted">
                  {props.labels.vectorStatus}
                </Text>
                <StatusTag
                  value={item.vectorStatus}
                  tone={item.vectorStatus === 'error' ? 'warning' : 'neutral'}
                />
              </Box>
              <Button
                mt={3}
                size="sm"
                onClick={(event) => void open(item, index, event.currentTarget)}
                busy={loading === item.id}
              >
                {loading === item.id ? props.labels.loadingPreview : props.labels.preview}
              </Button>
            </Box>
          </Box>
        ))}
      </Grid>
      {failed ? (
        <Alert mt={4} status="warning" variant="left-accent">
          <AlertIcon />
          <AlertDescription>{props.labels.previewExpired}</AlertDescription>
        </Alert>
      ) : null}
      <PhotoSlider
        visible={active !== null && Boolean(url)}
        images={url ? [{ src: url, key: String(active) }] : []}
        index={0}
        onClose={close}
        afterClose={() => globalThis.requestAnimationFrame(() => triggerRef.current?.focus())}
        maskClosable
      />
    </Box>
  );
}
