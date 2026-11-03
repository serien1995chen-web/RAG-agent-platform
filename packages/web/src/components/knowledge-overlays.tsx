'use client';

import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button as ChakraButton,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  Flex,
  Text,
} from '@chakra-ui/react';
import { useRef, type ReactNode } from 'react';
import { useKnowledgeI18n } from '../i18n';
import { Button } from './knowledge-primitives';

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  destructive?: boolean;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { t } = useKnowledgeI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      isOpen={props.isOpen}
      leastDestructiveRef={cancelRef}
      onClose={props.onClose}
      isCentered
    >
      <AlertDialogOverlay bg="rgba(20,39,43,0.58)" backdropFilter="blur(4px)">
        <AlertDialogContent
          borderWidth="1px"
          borderColor="kn.line"
          borderRadius="md"
          bg="kn.surface"
          boxShadow="kn2"
        >
          <AlertDialogHeader fontSize="lg" fontWeight="650">
            {props.title}
          </AlertDialogHeader>
          <AlertDialogBody className="confirm-copy" py={2}>
            {props.description}
          </AlertDialogBody>
          <AlertDialogFooter gap={2}>
            <ChakraButton
              ref={cancelRef}
              variant="outline"
              minH="40px"
              borderColor="kn.line"
              onClick={props.onClose}
            >
              {props.cancelLabel ?? t('common.cancel')}
            </ChakraButton>
            <Button
              tone={props.destructive ? 'danger' : 'primary'}
              busy={props.busy}
              onClick={() => void props.onConfirm()}
            >
              {props.confirmLabel ?? t('common.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
}

export interface FormDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export function FormDrawer(props: FormDrawerProps) {
  return (
    <Drawer
      isOpen={props.isOpen}
      placement="right"
      onClose={props.onClose}
      size={props.size ?? 'md'}
      preserveScrollBarGap
    >
      <DrawerOverlay bg="rgba(20,39,43,0.58)" backdropFilter="blur(4px)" />
      <DrawerContent className="drawer-shell" maxW="min(560px, 100vw)">
        <DrawerCloseButton top={4} right={4} />
        <DrawerHeader className="drawer-header" px={6} py={5} pr={14}>
          <Text as="h2" m={0} fontSize="lg" fontWeight="650" letterSpacing="0">
            {props.title}
          </Text>
          {props.description ? (
            <Text mt={2} mb={0} color="kn.inkMuted" fontSize="sm" fontWeight="400">
              {props.description}
            </Text>
          ) : null}
        </DrawerHeader>
        <DrawerBody px={6} py={5}>
          {props.children}
        </DrawerBody>
        {props.footer ? (
          <DrawerFooter
            px={6}
            py={4}
            gap={2}
            borderTopWidth="1px"
            borderColor="kn.line"
            bg="kn.surface"
          >
            {props.footer}
          </DrawerFooter>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

export interface JobDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function JobDrawer(props: JobDrawerProps) {
  return (
    <FormDrawer
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={props.title}
      description="Live state is read from GET /v1/knowledge/jobs/{jobId}."
      size="lg"
    >
      {props.children}
    </FormDrawer>
  );
}

export function PageToolbar(props: {
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Flex
      className={props.className ?? 'page-toolbar'}
      align={{ base: 'stretch', md: 'center' }}
      justify="space-between"
      direction={{ base: 'column', md: 'row' }}
      gap={3}
      py={2}
    >
      {props.summary ? <Box minW={0}>{props.summary}</Box> : <Box />}
      <Flex align="center" gap={2} wrap="wrap">
        {props.children}
      </Flex>
    </Flex>
  );
}
