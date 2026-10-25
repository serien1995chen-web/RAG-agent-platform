'use client';

import {
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
  useDisclosure,
} from '@chakra-ui/react';
import { useRef, useState } from 'react';
import { knowledgeRequest } from '../client/knowledge-client';
import { useKnowledgeI18n } from '../i18n';
import { Button, ProblemNotice } from './knowledge-primitives';

interface PreviewSection {
  order: number;
  text: string;
}

export function FilePreviewPanel({ sourceId }: { sourceId: string }) {
  const { t } = useKnowledgeI18n();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [sections, setSections] = useState<PreviewSection[]>([]);
  const [problem, setProblem] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openPreview = async () => {
    setLoading(true);
    setProblem(null);
    try {
      const result = await knowledgeRequest<{ sections: PreviewSection[] }>(
        `/v1/knowledge/sources/${sourceId}/preview`,
      );
      setSections(result.sections);
      onOpen();
    } catch (error) {
      setProblem(error);
      onOpen();
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button ref={triggerRef} size="sm" busy={loading} onClick={() => void openPreview()}>
        {t('sources.preview')}
      </Button>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        finalFocusRef={triggerRef}
        size="xl"
        returnFocusOnClose
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{t('files.previewTitle')}</ModalHeader>
          <ModalCloseButton aria-label={t('files.close')} />
          <ModalBody pb={6}>
            {problem ? <ProblemNotice error={problem} /> : null}
            {sections.map((section) => (
              <Text key={section.order} whiteSpace="pre-wrap" fontSize="sm" mb={3}>
                {section.text}
              </Text>
            ))}
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
